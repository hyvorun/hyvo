"""SocialWorld lifecycle, actions, validation and the platform watchdog."""

from __future__ import annotations

import asyncio
import shutil
import sqlite3
from pathlib import Path
from types import ModuleType

import pytest

from hyvo.personas import AgentSpec
from hyvo.sim.social import (
    DB_FILE_NAME,
    SocialActionRejected,
    SocialWorld,
    SocialWorldError,
)

pytestmark = pytest.mark.oasis


def db_rows(world: SocialWorld, sql: str) -> list[tuple]:
    """Read the world's database the way an outside observer would."""
    with sqlite3.connect(f"{world.db_path.resolve().as_uri()}?mode=ro", uri=True) as conn:
        return conn.execute(sql).fetchall()


async def test_post_reply_and_like_return_refs_and_bools(world: SocialWorld):
    post = await world.create_post("a01", "gm, pool looks thin \U0001f440")
    reply = await world.create_reply("a02", post, "thin but growing")
    nested = await world.create_reply("a03", reply, "agree with a02")
    assert (post, reply, nested) == ("p1", "c1", "c2")
    assert await world.like("a02", post) is True
    assert await world.like("a01", reply) is True
    assert await world.like("a04", nested) is True
    assert db_rows(world, "SELECT comment_id, post_id FROM comment") == [(1, 1), (2, 1)]
    assert db_rows(world, 'SELECT user_id, post_id FROM "like"') == [(1, 1)]
    assert db_rows(world, "SELECT user_id, comment_id FROM comment_like") == [(0, 1), (3, 2)]
    assert world.rejections == ()


async def test_agents_map_to_contiguous_oasis_ids(world: SocialWorld, crowd: list[AgentSpec]):
    users = db_rows(world, "SELECT user_id, agent_id, user_name, name FROM user ORDER BY user_id")
    assert users == [
        (index, index, spec.handle.removeprefix("@"), spec.handle)
        for index, spec in enumerate(crowd)
    ]
    for index, spec in enumerate(crowd):
        ref = await world.create_post(spec.agent_id, f"post by {spec.agent_id}")
        assert db_rows(world, f"SELECT user_id FROM post WHERE post_id = {ref[1:]}") == [(index,)]


@pytest.mark.parametrize(
    ("agent_id", "ref", "reason"),
    [
        ("a02", "p99", "p99 does not exist"),
        ("a02", "c1", "c1 does not exist"),
        ("a02", "x1", "is not a post or reply ref"),
        ("a02", "p0", "is not a post or reply ref"),
        ("a02", "p1\n", "is not a post or reply ref"),
        ("a02", 1, "is not a post or reply ref"),
        ("a99", "p1", "unknown agent 'a99'"),
        ("a01", "p1", "agents cannot like their own content"),
    ],
)
async def test_invalid_likes_return_false_with_a_reason(world: SocialWorld, agent_id, ref, reason):
    await world.create_post("a01", "gm")
    assert await world.like(agent_id, ref) is False
    [rejection] = world.rejections
    assert (rejection.round, rejection.action, rejection.target) == (1, "like", str(ref))
    assert reason in rejection.reason
    assert db_rows(world, 'SELECT COUNT(*) FROM "like"') == [(0,)]  # nothing reached OASIS


async def test_a_repeat_like_is_refused_in_any_round(world: SocialWorld):
    post = await world.create_post("a01", "gm")
    reply = await world.create_reply("a01", post, "self reply is fine")
    assert await world.like("a02", post) is True
    assert await world.like("a02", reply) is True
    world.set_round(2)
    assert await world.like("a02", post) is False
    assert await world.like("a02", reply) is False
    assert [r.reason for r in world.rejections] == ["a02 already liked p1", "a02 already liked c1"]
    assert db_rows(world, "SELECT num_likes FROM post") == [(1,)]


async def test_concurrent_identical_likes_send_one(world: SocialWorld):
    post = await world.create_post("a01", "gm")
    results = await asyncio.gather(*(world.like("a02", post) for _ in range(3)))
    assert sorted(results) == [False, False, True]
    assert db_rows(world, 'SELECT COUNT(*) FROM "like"') == [(1,)]


@pytest.mark.parametrize("text", ["", "   \n", None, 42])
async def test_blank_or_non_text_is_rejected(world: SocialWorld, text):
    with pytest.raises(SocialActionRejected, match="non-empty string"):
        await world.create_post("a01", text)
    post = await world.create_post("a01", "gm")
    with pytest.raises(SocialActionRejected, match="non-empty string"):
        await world.create_reply("a02", post, text)
    assert [r.action for r in world.rejections] == ["post", "reply"]


async def test_posts_and_replies_to_unknown_targets_are_rejected(world: SocialWorld):
    with pytest.raises(SocialActionRejected, match="unknown agent 'a99'") as caught:
        await world.create_post("a99", "hi")
    assert caught.value.rejection.action == "post"
    post = await world.create_post("a01", "gm")
    for target, reason in [("p42", "p42 does not exist"), ("c7", "c7 does not exist"),
                           ("post1", "not a post or reply ref")]:  # fmt: skip
        with pytest.raises(SocialActionRejected, match=reason) as caught:
            await world.create_reply("a02", target, "hello?")
        assert (caught.value.rejection.action, caught.value.rejection.target) == ("reply", target)
    assert post == "p1"
    assert db_rows(world, "SELECT COUNT(*) FROM comment") == [(0,)]


async def test_identical_actions_are_sent_once_per_round(world: SocialWorld):
    post = await world.create_post("a01", "same words")
    with pytest.raises(SocialActionRejected, match="already sent this round"):
        await world.create_post("a01", "same words")
    assert await world.create_post("a02", "same words") == "p2"  # another agent may say it
    reply = await world.create_reply("a03", post, "+1")
    with pytest.raises(SocialActionRejected, match="already sent this round"):
        await world.create_reply("a03", reply, "+1")  # lands on the same post
    world.set_round(1)  # setting the same round again keeps the record
    with pytest.raises(SocialActionRejected):
        await world.create_post("a01", "same words")
    world.set_round(2)
    assert await world.create_post("a01", "same words") == "p3"
    assert await world.create_reply("a03", post, "+1") == "c2"


async def test_round_rules(oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path):
    async with SocialWorld(tmp_path / "job", crowd) as world:
        assert world.current_round is None
        with pytest.raises(SocialWorldError, match="set_round"):
            await world.create_post("a01", "too early")
        with pytest.raises(SocialWorldError, match="set_round"):
            await world.like("a01", "p1")
        for bad in (0, -1, True, 1.0, "2"):
            with pytest.raises(ValueError, match="round must be"):
                world.set_round(bad)
        world.set_round(3)
        with pytest.raises(ValueError, match="before the current round"):
            world.set_round(2)
        assert world.current_round == 3


@pytest.mark.parametrize("recsys", ["reddit", "random"])
async def test_recsys_choice_sets_the_oasis_clock(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path, recsys: str
):
    async with SocialWorld(tmp_path / "job", crowd, recsys=recsys) as world:
        world.set_round(1)
        post = await world.create_post("a01", "round one")
        world.set_round(2)
        await world.create_reply("a02", post, "round two")
        assert await world.like("a03", post) is True
        stamps = [row[0] for row in db_rows(world, "SELECT created_at FROM post")]
        stamps += [row[0] for row in db_rows(world, "SELECT created_at FROM comment")]
        if recsys == "random":
            assert stamps == [1, 2]  # twitter-mode clock: Hyvo's round number
        else:
            assert all(isinstance(stamp, str) and stamp.startswith("20") for stamp in stamps)
        await world._platform.update_rec_table()  # the light recsys stand-in is wired in
        assert db_rows(world, "SELECT DISTINCT post_id FROM rec") == [(1,)]
        assert [p.round for p in world.all_content()] == [1, 2]


async def test_two_worlds_in_one_process_stay_independent(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path
):
    async with (
        SocialWorld(tmp_path / "one", crowd) as one,
        SocialWorld(tmp_path / "two", crowd[:2], recsys="random") as two,
    ):
        one.set_round(1)
        two.set_round(5)
        first = await asyncio.gather(one.create_post("a01", "one"), two.create_post("a02", "two"))
        assert first == ["p1", "p1"]
        assert await two.like("a01", "p1") is True
        assert one.likes_by_ref() == {"p1": 0}
        assert [(p.author_agent_id, p.round, p.likes) for p in two.all_content()] == [("a02", 5, 1)]


async def test_start_replaces_a_stale_database(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path
):
    job = tmp_path / "job"
    job.mkdir()
    (job / DB_FILE_NAME).write_bytes(b"not a database")
    (job / f"{DB_FILE_NAME}-journal").write_bytes(b"stale journal")
    async with SocialWorld(job, crowd) as world:
        world.set_round(1)
        assert world.all_content() == []
        assert await world.create_post("a01", "fresh start") == "p1"
    assert not (job / f"{DB_FILE_NAME}-journal").exists()


async def test_close_releases_the_job_dir(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path
):
    job = tmp_path / "job"
    world = SocialWorld(job, crowd)
    try:
        await world.start()
        world.set_round(1)
        post = await world.create_post("a01", "gm")
        await world.create_reply("a02", post, "gm")
        assert await world.like("a03", post) is True
    finally:
        await world.close()
    await world.close()  # idempotent
    shutil.rmtree(job)  # Windows refuses this while a connection is open
    assert not job.exists()
    with pytest.raises(SocialWorldError, match="closed"):
        await world.create_post("a01", "late")
    with pytest.raises(SocialWorldError, match="closed"):
        world.all_content()
    with pytest.raises(SocialWorldError, match="closed"):
        world.set_round(2)
    with pytest.raises(SocialWorldError, match="already started"):
        await world.start()


async def test_calls_before_start_fail_and_close_is_safe(crowd: list[AgentSpec], tmp_path: Path):
    world = SocialWorld(tmp_path / "job", crowd)
    with pytest.raises(SocialWorldError, match="not started"):
        world.feed()
    with pytest.raises(SocialWorldError, match="not started"):
        await world.like("a01", "p1")
    await world.close()


async def test_watchdog_fails_fast_when_the_platform_task_dies(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path, monkeypatch
):
    async def explode(self, agent_id, content):
        raise RuntimeError("platform exploded")

    job = tmp_path / "job"
    async with SocialWorld(job, crowd) as world:
        world.set_round(1)
        post = await world.create_post("a01", "before the crash")
        monkeypatch.setattr(oasis_module.Platform, "create_post", explode)
        with pytest.raises(SocialWorldError, match="platform stopped") as caught:
            await asyncio.wait_for(world.create_post("a02", "boom"), timeout=5)
        assert isinstance(caught.value.__cause__, RuntimeError)
        with pytest.raises(SocialWorldError, match="failed"):
            await world.like("a03", post)
        assert [p.ref for p in world.all_content()] == ["p1"]  # reads still work
    shutil.rmtree(job)  # close() released the database the dead platform left open


async def test_a_hung_oasis_call_times_out_and_close_still_cleans_up(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path, monkeypatch
):
    async def hang(self, agent_id, content):
        await asyncio.Event().wait()

    job = tmp_path / "job"
    monkeypatch.setattr(oasis_module.Platform, "create_post", hang)
    async with SocialWorld(job, crowd, timeout=0.3) as world:
        world.set_round(1)
        with pytest.raises(SocialWorldError, match="did not finish within 0.3 s"):
            await world.create_post("a01", "stuck")
        with pytest.raises(SocialWorldError, match="failed"):
            await world.create_post("a02", "after")
    shutil.rmtree(job)


async def test_a_cancelled_close_still_releases_the_database(
    oasis_module: ModuleType, crowd: list[AgentSpec], tmp_path: Path, monkeypatch
):
    async def hang(self, agent_id, content):
        await asyncio.Event().wait()

    job = tmp_path / "job"
    monkeypatch.setattr(oasis_module.Platform, "create_post", hang)
    world = SocialWorld(job, crowd)
    await world.start()
    world.set_round(1)
    stuck = asyncio.ensure_future(world.create_post("a01", "keeps the platform busy"))
    closing = asyncio.ensure_future(world.close())
    await asyncio.sleep(0.05)  # close() is now waiting for the busy platform
    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    with pytest.raises(SocialWorldError):
        await stuck  # the platform was cancelled under it
    shutil.rmtree(job)


def test_constructor_validates_its_arguments(crowd: list[AgentSpec], tmp_path: Path):
    with pytest.raises(ValueError, match="recsys"):
        SocialWorld(tmp_path, crowd, recsys="twhin-bert")
    with pytest.raises(ValueError, match="at least one agent"):
        SocialWorld(tmp_path, [])
    with pytest.raises(ValueError, match="unique"):
        SocialWorld(tmp_path, [crowd[0], crowd[0]])
    with pytest.raises(ValueError, match="timeout"):
        SocialWorld(tmp_path, crowd, timeout=0)
