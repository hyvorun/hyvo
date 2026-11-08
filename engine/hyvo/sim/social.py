"""Hyvo's social world: one OASIS platform per job, driven by direct action calls.

Hyvo makes the decisions; OASIS executes and stores the social actions (MIROFISH_NOTES.md sec. 9):

- ``agents[i]`` is OASIS agent and user ``i`` (ids contiguous ``0..N-1``, as OASIS requires).
  Agents are built on camel's STUB model, so construction needs no key, no network and no
  tiktoken download, and OASIS never calls a model.
- Posts, replies and likes go through direct ``agent.env.action.<method>`` calls, which return the
  new ids (``env.step`` drops them), and every result's ``success`` is checked.
- Every target is validated here (OASIS has no foreign-key checks), own content cannot be liked,
  and an identical action is never sent twice in a round (the OASIS trace primary key rejects it).
- Rounds belong to Hyvo (the Reddit-mode OASIS clock follows the wall clock): :meth:`set_round`
  stamps each new post and reply with the round it was created in.
- Reads come straight from SQLite over a separate read-only connection, never through OASIS
  ``refresh()``, which writes trace rows. OASIS's own ``rec`` table is not maintained.

Content refs follow run.json ``PostId``: ``p<post_id>`` for a post, ``c<comment_id>`` for a reply.
OASIS comments are flat, so a reply to a reply attaches to the same post.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import os
import re
import sqlite3
import uuid
import warnings
from collections.abc import Coroutine, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self, TypeVar

from hyvo.personas import AgentSpec
from hyvo.sim.oasis_boot import import_oasis

log = logging.getLogger(__name__)

T = TypeVar("T")

DB_FILE_NAME = "social.db"
RECSYS_TYPES = ("reddit", "random")  # the other OASIS recommenders need torch or are broken
DEFAULT_TIMEOUT_S = 30.0

# Feed ranking, see SocialWorld.feed and hot_score.
REPLY_WEIGHT = 2
GRAVITY = 1.5

_REF = re.compile(r"[pc][1-9][0-9]*")
# Both queries return (id, text, likes, replies); OASIS comments are flat, so replies have none.
_POSTS_SQL = """
    SELECT p.post_id, p.content, p.num_likes,
           (SELECT COUNT(*) FROM comment AS c WHERE c.post_id = p.post_id)
    FROM post AS p
"""
_COMMENTS_SQL = "SELECT comment_id, content, num_likes, 0 FROM comment"


@dataclass(frozen=True)
class SocialPost:
    """A post or a reply as Hyvo reads it.

    ``reply_to`` is the parent post's ref for a reply and ``None`` for a post. ``replies`` counts
    the replies on a post (always 0 for a reply). ``likes`` is the count when this was read.
    """

    ref: str
    author_agent_id: str
    author_handle: str
    text: str
    reply_to: str | None
    likes: int
    replies: int
    round: int

    def to_run_dict(self) -> dict[str, Any]:
        """The run.json ``posts[]`` entry."""
        return {
            "id": self.ref,
            "agentId": self.author_agent_id,
            "text": self.text,
            "replyTo": self.reply_to,
            "likes": self.likes,
        }


@dataclass(frozen=True)
class Rejection:
    """A social action that failed validation and was never sent to OASIS."""

    round: int
    agent_id: str
    action: str  # "post" | "reply" | "like"
    target: str | None  # the ref a reply or like pointed at
    reason: str


class SocialWorldError(RuntimeError):
    """The social world cannot serve the call: not started, closed, or OASIS failed."""


class SocialActionRejected(ValueError):
    """A post or reply failed validation; ``rejection`` holds the details."""

    def __init__(self, rejection: Rejection) -> None:
        super().__init__(rejection.reason)
        self.rejection = rejection


def hot_score(post: SocialPost, current_round: int) -> float:
    """Feed rank of a post: ``(1 + likes + REPLY_WEIGHT * replies) / (age + 2) ** GRAVITY``.

    Hacker News style (weight 2, gravity 1.5) with ``age`` in Hyvo rounds since the post was
    created: a quiet new post starts at about 0.35, one like outweighs one round of age but not
    two, and engagement has to keep coming for a post to stay on top.
    """
    age = max(0, current_round - post.round)
    return (1 + post.likes + REPLY_WEIGHT * post.replies) / (age + 2) ** GRAVITY


class SocialWorld:
    """One job's OASIS social platform (async context manager).

    ``async with SocialWorld(job_dir, agents) as world:`` starts OASIS with a fresh
    ``job_dir/social.db``; leaving the block stops it and releases the database, so ``job_dir``
    can be deleted afterwards (also on Windows). Call :meth:`set_round` before the first action
    of each round. Content must be created through this object, which owns the round mapping.
    """

    def __init__(
        self,
        job_dir: str | os.PathLike[str],
        agents: Sequence[AgentSpec],
        recsys: str = "reddit",
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        """
        Args:
            job_dir: directory for ``social.db`` (created if missing).
            agents: the crowd; ``agents[i]`` becomes OASIS agent ``i``. Agent ids must be unique.
            recsys: OASIS recommender, ``"reddit"`` or ``"random"``. Hyvo's feed does not use it,
                but it fixes the OASIS clock: wall-clock timestamps for reddit, round numbers
                for random.
            timeout: seconds one OASIS call (or the shutdown) may take before the world fails.
        """
        if recsys not in RECSYS_TYPES:
            raise ValueError(f"recsys must be one of {RECSYS_TYPES}, got {recsys!r}")
        if not agents:
            raise ValueError("a social world needs at least one agent")
        ids = [agent.agent_id for agent in agents]
        if len(set(ids)) != len(ids):
            raise ValueError("agent ids must be unique")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.job_dir = Path(job_dir).resolve()  # OASIS and the reader must agree on the file
        self.db_path = self.job_dir / DB_FILE_NAME
        self.recsys = recsys
        self.agents: tuple[AgentSpec, ...] = tuple(agents)
        self._index = {agent_id: index for index, agent_id in enumerate(ids)}
        self._timeout = timeout
        self._env: Any = None
        self._platform: Any = None
        self._reader: sqlite3.Connection | None = None
        self._started = False
        self._ready = False
        self._closed = False
        self._failure: SocialWorldError | None = None
        self._round: int | None = None
        self._items: dict[str, _Item] = {}  # every post and reply, in creation order
        self._sent: set[tuple[Any, ...]] = set()  # posts and replies sent this round
        self._liked: set[tuple[int, str]] = set()
        self._rejections: list[Rejection] = []

    # --- lifecycle -------------------------------------------------------------------------------

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    async def start(self) -> None:
        """Create the database, the agents and the platform, and sign every agent up."""
        if self._started:
            raise SocialWorldError("the social world was already started")
        self._started = True
        try:
            await self._boot()
        except BaseException:
            await self.close()
            raise
        self._ready = True

    async def _boot(self) -> None:
        oasis = import_oasis()
        self.job_dir.mkdir(parents=True, exist_ok=True)
        for stale in (self.db_path, self.db_path.with_name(DB_FILE_NAME + "-journal")):
            stale.unlink(missing_ok=True)  # OASIS would silently reuse an old database
        os.environ["OASIS_DB_PATH"] = str(self.db_path)  # read by OASIS observation helpers
        graph = _agent_graph(oasis, self.agents)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):  # create_db() print()s the database path
            self._platform = oasis.Platform(
                db_path=str(self.db_path),
                channel=_PromptChannel(),
                recsys_type=self.recsys,
                allow_self_rating=False,
            )
        log.debug("OASIS platform output: %s", printed.getvalue().strip())
        self._env = oasis.make(
            agent_graph=graph, platform=self._platform, database_path=str(self.db_path)
        )
        self._reader = sqlite3.connect(f"{self.db_path.as_uri()}?mode=ro", uri=True)
        await self._guarded(self._env.reset(), "sign-up")
        self._env.platform_task.add_done_callback(self._on_platform_done)
        users = self._reader.execute(
            "SELECT user_id, agent_id FROM user ORDER BY user_id"
        ).fetchall()
        if users != [(index, index) for index in range(len(self.agents))]:
            raise SocialWorldError(f"OASIS signed up {len(users)} of {len(self.agents)} agents")

    async def close(self) -> None:
        """Stop OASIS and close both database connections.

        Idempotent and safe in ``finally``: OASIS shutdown errors are logged, not raised, and the
        connections are closed even if this call is cancelled.
        """
        if self._closed:
            return
        self._closed = True
        self._ready = False
        try:
            await self._stop_platform()
        finally:
            task = getattr(self._env, "platform_task", None)
            if task is not None and not task.done():
                task.cancel()  # shutdown was cut short; do not leave the platform running
            if self._platform is not None:
                with contextlib.suppress(sqlite3.Error):
                    self._platform.db.close()  # still open when the platform task died
            if self._reader is not None:
                self._reader.close()
                self._reader = None

    async def _stop_platform(self) -> None:
        task = getattr(self._env, "platform_task", None)
        if task is None or task.done():
            return
        try:
            await asyncio.wait_for(self._env.close(), self._timeout)
        except Exception as error:  # noqa: BLE001 (close() must not raise; TimeoutError too)
            log.warning("OASIS did not shut down cleanly: %r", error)
        if not task.done():
            task.cancel()
            await asyncio.wait({task}, timeout=self._timeout)

    # --- rounds and actions ---------------------------------------------------------------------

    @property
    def current_round(self) -> int | None:
        return self._round

    @property
    def rejections(self) -> tuple[Rejection, ...]:
        """Every rejected action so far, oldest first."""
        return tuple(self._rejections)

    def set_round(self, n: int) -> None:
        """Begin round ``n`` (1-based, never decreasing); new content is stamped with it."""
        self._require_open()
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            raise ValueError(f"round must be an integer >= 1, got {n!r}")
        if self._round is not None and n < self._round:
            raise ValueError(f"round {n} comes before the current round {self._round}")
        if n != self._round:
            self._sent.clear()
        self._round = n
        self._platform.sandbox_clock.time_step = n  # OASIS timestamps when recsys is "random"

    async def create_post(self, agent_id: str, text: str) -> str:
        """Publish a top-level post and return its ref ``p<post_id>``.

        Raises:
            SocialActionRejected: unknown agent, blank text, or the same post this round.
        """
        round_n = self._require_round()
        try:
            index = self._author(agent_id)
            _check_text(text)
            self._claim(("post", index, text), "the same post was already sent this round")
        except _Refused as refused:
            rejection = self._reject(round_n, agent_id, "post", None, str(refused))
            raise SocialActionRejected(rejection) from None
        result = await self._act(index, "create_post", text)
        ref = f"p{result['post_id']}"
        self._items[ref] = _Item(author=index, round=round_n, parent=None, target=None)
        return ref

    async def create_reply(self, agent_id: str, parent_ref: str, text: str) -> str:
        """Reply to a post ``p<n>`` or to a reply ``c<n>``; return the new ref ``c<comment_id>``.

        A reply to a reply attaches to that reply's post (OASIS comments are flat).

        Raises:
            SocialActionRejected: unknown agent or target, blank text, or the same reply to the
                same post this round.
        """
        round_n = self._require_round()
        try:
            index = self._author(agent_id)
            target = self._item(parent_ref)
            _check_text(text)
            post_ref = target.parent or parent_ref
            self._claim(
                ("reply", index, post_ref, text), "the same reply was already sent this round"
            )
        except _Refused as refused:
            rejection = self._reject(round_n, agent_id, "reply", parent_ref, str(refused))
            raise SocialActionRejected(rejection) from None
        result = await self._act(index, "create_comment", int(post_ref[1:]), text)
        ref = f"c{result['comment_id']}"
        self._items[ref] = _Item(author=index, round=round_n, parent=post_ref, target=parent_ref)
        return ref

    async def like(self, agent_id: str, ref: str) -> bool:
        """Like a post ``p<n>`` or a reply ``c<n>``; ``True`` once OASIS recorded it.

        ``False``, with the reason in :attr:`rejections`, for an unknown agent or ref, the
        agent's own content, or something the agent already liked (in any round).
        """
        round_n = self._require_round()
        try:
            index = self._author(agent_id)
            if self._item(ref).author == index:
                raise _Refused("agents cannot like their own content")
            if (index, ref) in self._liked:
                raise _Refused(f"{agent_id} already liked {ref}")
            self._liked.add((index, ref))
        except _Refused as refused:
            self._reject(round_n, agent_id, "like", ref, str(refused))
            return False
        method = "like_post" if ref.startswith("p") else "like_comment"
        await self._act(index, method, int(ref[1:]))
        return True

    # --- reads (SQLite, read-only connection) ---------------------------------------------------

    def feed(self, limit: int = 15, replies_per_post: int = 2) -> list[SocialPost]:
        """The global feed for the current round, as a flat list.

        The ``limit`` hottest posts (:func:`hot_score`; ties go to the newer post), each
        followed by up to ``replies_per_post`` of its replies, most liked first, then newest.
        Every agent sees the same feed, its own posts included.
        """
        _check_count("limit", limit)
        _check_count("replies_per_post", replies_per_post)
        content = self._snapshot()
        now = self._round or 0
        order = {post.ref: position for position, post in enumerate(content)}
        replies: dict[str, list[SocialPost]] = {}
        for item in content:
            if item.reply_to is not None:
                replies.setdefault(item.reply_to, []).append(item)
        posts = [post for post in content if post.reply_to is None]
        posts.sort(key=lambda post: (hot_score(post, now), order[post.ref]), reverse=True)
        out: list[SocialPost] = []
        for post in posts[:limit]:
            out.append(post)
            thread = replies.get(post.ref, [])
            thread.sort(key=lambda reply: (reply.likes, order[reply.ref]), reverse=True)
            out.extend(thread[:replies_per_post])
        return out

    def posts_by(self, agent_id: str, limit: int = 5) -> list[SocialPost]:
        """The agent's own posts and replies, newest first."""
        self._known(agent_id)
        _check_count("limit", limit)
        mine = [post for post in reversed(self._snapshot()) if post.author_agent_id == agent_id]
        return mine[:limit]

    def replies_to(self, agent_id: str, limit: int = 5) -> list[SocialPost]:
        """Replies by other agents on the agent's posts or to its replies, newest first."""
        index = self._known(agent_id)
        _check_count("limit", limit)
        out: list[SocialPost] = []
        for post in reversed(self._snapshot()):
            if len(out) == limit:
                break
            item = self._items[post.ref]
            if item.parent is None or item.author == index:
                continue
            if index in (self._items[item.parent].author, self._items[item.target].author):
                out.append(post)
        return out

    def liked_by(self, agent_id: str) -> set[str]:
        """Refs of the posts and replies the agent has liked (in any round)."""
        index = self._known(agent_id)
        return {ref for liker, ref in self._liked if liker == index}

    def likes_by_ref(self) -> dict[str, int]:
        """Current likes of every post and reply (final likes once the run is over)."""
        return {post.ref: post.likes for post in self._snapshot()}

    def all_content(self) -> list[SocialPost]:
        """Every post and reply in creation order, so a reply always follows its post."""
        return self._snapshot()

    # --- internals ------------------------------------------------------------------------------

    def _snapshot(self) -> list[SocialPost]:
        if self._reader is None or not self._ready:
            raise SocialWorldError(self._state_message())
        posts = {f"p{row[0]}": row[1:] for row in self._reader.execute(_POSTS_SQL).fetchall()}
        comments = {f"c{row[0]}": row[1:] for row in self._reader.execute(_COMMENTS_SQL).fetchall()}
        out = []
        for ref, item in self._items.items():
            row = posts.get(ref) if item.parent is None else comments.get(ref)
            if row is None:
                raise SocialWorldError(f"{ref} is missing from {self.db_path}")
            text, likes, replies = row
            spec = self.agents[item.author]
            out.append(
                SocialPost(
                    ref=ref,
                    author_agent_id=spec.agent_id,
                    author_handle=spec.handle,
                    text=text,
                    reply_to=item.parent,
                    likes=likes,
                    replies=replies,
                    round=item.round,
                )
            )
        return out

    async def _act(self, index: int, method: str, *args: Any) -> dict[str, Any]:
        """Run one OASIS action for agent ``index``; validation already passed, so a failure is
        a broken world, not a bad decision."""
        agent = self._env.agent_graph.get_agent(index)
        result = await self._guarded(getattr(agent.env.action, method)(*args), method)
        if not isinstance(result, dict) or not result.get("success"):
            raise SocialWorldError(
                f"OASIS {method} failed for {self.agents[index].agent_id}: {result!r}"
            )
        return result

    async def _guarded(self, call: Coroutine[Any, Any, T], what: str) -> T:
        """Await an OASIS call; fail fast if the platform task dies or the call hangs."""
        task = asyncio.ensure_future(call)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout
        try:
            while not task.done():
                platform = getattr(self._env, "platform_task", None)  # exists once reset() runs
                if platform is not None and platform.done():
                    raise self._fail(f"the OASIS platform stopped during {what}", platform)
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise self._fail(f"OASIS {what} did not finish within {self._timeout:g} s")
                waiting = {task} if platform is None else {task, platform}
                await asyncio.wait(
                    waiting, timeout=min(remaining, 0.25), return_when=asyncio.FIRST_COMPLETED
                )
            return task.result()
        finally:
            task.cancel()  # no-op once done

    def _on_platform_done(self, task: asyncio.Task[Any]) -> None:
        """Watchdog: the platform task only ends on its own when something broke."""
        if not self._closed:
            self._fail("the OASIS platform stopped", task)
        elif not task.cancelled():
            task.exception()  # retrieve it so asyncio does not log it as never retrieved

    def _fail(self, message: str, task: asyncio.Task[Any] | None = None) -> SocialWorldError:
        cause = task.exception() if task is not None and not task.cancelled() else None
        error = SocialWorldError(f"{message}: {cause!r}" if cause is not None else message)
        error.__cause__ = cause
        if self._failure is None:
            self._failure = error
            log.error("social world failed: %s", error)
        return error

    def _require_open(self) -> None:
        if not self._ready:
            raise SocialWorldError(self._state_message())

    def _require_round(self) -> int:
        self._require_open()
        if self._failure is not None:
            raise SocialWorldError(f"the social world failed: {self._failure}") from self._failure
        if self._round is None:
            raise SocialWorldError("call set_round() before the first action")
        return self._round

    def _state_message(self) -> str:
        if self._closed:
            return "the social world is closed"
        return "the social world is not started"

    def _author(self, agent_id: Any) -> int:
        index = self._index.get(agent_id) if isinstance(agent_id, str) else None
        if index is None:
            raise _Refused(f"unknown agent {agent_id!r}")
        return index

    def _known(self, agent_id: str) -> int:
        if agent_id not in self._index:
            raise ValueError(f"unknown agent {agent_id!r}")
        return self._index[agent_id]

    def _item(self, ref: Any) -> _Item:
        if not isinstance(ref, str) or not _REF.fullmatch(ref):
            raise _Refused(f"{ref!r} is not a post or reply ref (p<n> or c<n>)")
        item = self._items.get(ref)
        if item is None:
            raise _Refused(f"{ref} does not exist")
        return item

    def _claim(self, key: tuple[Any, ...], duplicate: str) -> None:
        if key in self._sent:
            raise _Refused(duplicate)
        self._sent.add(key)

    def _reject(
        self, round_n: int, agent_id: Any, action: str, target: Any, reason: str
    ) -> Rejection:
        rejection = Rejection(
            round=round_n,
            agent_id=str(agent_id),
            action=action,
            target=None if target is None else str(target),
            reason=reason,
        )
        self._rejections.append(rejection)
        log.debug("rejected %s by %s (target %s): %s", action, agent_id, target, reason)
        return rejection


@dataclass(frozen=True)
class _Item:
    """What Hyvo knows about a post or reply beyond the database row."""

    author: int  # OASIS agent index
    round: int
    parent: str | None  # a reply's post ref
    target: str | None  # what a reply answered: its post, or another reply on that post


class _Refused(Exception):
    """Internal: a validation failure, turned into a Rejection by the public method."""


class _PromptChannel:
    """Drop-in for OASIS's ``Channel`` that hands each result to its caller at once.

    OASIS 0.2.5's ``Channel.read_from_send_queue`` polls every 0.1 s, so each awaited action took
    up to 0.1 s. Here every request gets a future that the platform's reply resolves. These four
    methods are all OASIS uses (``Platform.running``, ``SocialAction.perform_action``,
    ``OasisEnv.close``).
    """

    def __init__(self) -> None:
        self.receive_queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._replies: dict[str, asyncio.Future[Any]] = {}

    async def receive_from(self) -> tuple[str, Any]:
        return await self.receive_queue.get()

    async def send_to(self, message: tuple[Any, ...]) -> None:
        reply = self._replies.get(message[0])
        if reply is not None and not reply.done():
            reply.set_result(message)

    async def write_to_receive_queue(self, action_info: Any) -> str:
        message_id = str(uuid.uuid4())
        self._replies[message_id] = asyncio.get_running_loop().create_future()
        await self.receive_queue.put((message_id, action_info))
        return message_id

    async def read_from_send_queue(self, message_id: str) -> Any:
        try:
            return await self._replies[message_id]
        finally:
            self._replies.pop(message_id, None)


def _agent_graph(oasis: Any, agents: Sequence[AgentSpec]) -> Any:
    """SocialAgents ``0..N-1`` on camel's STUB model (no key, no network, never called)."""
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType, ModelType

    model = ModelFactory.create(ModelPlatformType.OPENAI, ModelType.STUB)
    action = oasis.ActionType
    actions = [
        action.CREATE_POST,
        action.CREATE_COMMENT,
        action.LIKE_POST,
        action.LIKE_COMMENT,
        action.DO_NOTHING,
    ]
    graph = oasis.AgentGraph()
    with warnings.catch_warnings():
        # OASIS names igraph vertices with ints; igraph 0.11 warns once per agent.
        warnings.filterwarnings("ignore", "You are using integers as vertex names")
        for index, spec in enumerate(agents):
            graph.add_agent(
                oasis.SocialAgent(
                    agent_id=index,
                    user_info=_user_info(oasis, spec),
                    agent_graph=graph,
                    model=model,
                    available_actions=actions,
                )
            )
    return graph


def _user_info(oasis: Any, spec: AgentSpec) -> Any:
    return oasis.UserInfo(
        user_name=spec.handle.removeprefix("@"),
        name=spec.handle,
        description=spec.persona.label,
        # OASIS raises UnboundLocalError when other_info has no user_profile.
        profile={"other_info": {"user_profile": spec.persona.describe()}},
        # The reddit template needs gender/age/MBTI and print()s the profile.
        recsys_type="twitter",
    )


def _check_text(text: Any) -> None:
    if not isinstance(text, str) or not text.strip():
        raise _Refused("text must be a non-empty string")


def _check_count(name: str, value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be an integer >= 0, got {value!r}")
