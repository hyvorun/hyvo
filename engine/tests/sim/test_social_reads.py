"""SocialWorld reads: feed ranking, likes, round mapping, per-agent views (all from SQLite)."""

from __future__ import annotations

import math
import sqlite3

import pytest

from hyvo.personas import AgentSpec
from hyvo.runfile.models import Post
from hyvo.sim.social import SocialPost, SocialWorld, hot_score

pytestmark = pytest.mark.oasis


def refs(posts: list[SocialPost]) -> list[str]:
    return [post.ref for post in posts]


def trace_rows(world: SocialWorld) -> int:
    with sqlite3.connect(f"{world.db_path.resolve().as_uri()}?mode=ro", uri=True) as conn:
        return conn.execute("SELECT COUNT(*) FROM trace").fetchone()[0]


def test_hot_score_formula():
    def post(round_n: int, likes: int, replies: int) -> SocialPost:
        return SocialPost("p1", "a01", "@quietferret42", "t", None, likes, replies, round_n)

    assert hot_score(post(3, 0, 0), 3) == pytest.approx(1 / 2**1.5)
    assert hot_score(post(1, 3, 1), 3) == pytest.approx(6 / 4**1.5)
    assert hot_score(post(5, 0, 0), 3) == hot_score(post(3, 0, 0), 3)  # no negative age
    assert hot_score(post(2, 1, 0), 3) > hot_score(post(3, 0, 0), 3)  # a like beats one round
    assert hot_score(post(1, 1, 0), 3) < hot_score(post(3, 0, 0), 3)  # but not two


async def test_feed_ranks_by_hot_score_and_threads_replies(world: SocialWorld):
    p1 = await world.create_post("a01", "alpha")
    p2 = await world.create_post("a02", "beta")
    p3 = await world.create_post("a03", "gamma")
    for fan in ("a02", "a03", "a04"):
        assert await world.like(fan, p1)
    c1 = await world.create_reply("a04", p3, "a reply on gamma")
    world.set_round(2)
    p4 = await world.create_post("a05", "delta")

    feed = world.feed()
    # p1: 4/3^1.5 = 0.77, p3: 3/3^1.5 = 0.58 (+ its reply), p4: 1/2^1.5 = 0.35, p2: 1/3^1.5 = 0.19
    assert refs(feed) == [p1, p3, c1, p4, p2]
    posts = [post for post in feed if post.reply_to is None]
    scores = [hot_score(post, 2) for post in posts]
    assert scores == sorted(scores, reverse=True)
    assert (feed[0].likes, feed[1].replies, feed[2].reply_to) == (3, 1, p3)
    assert refs(world.feed(limit=2)) == [p1, p3, c1]
    assert refs(world.feed(limit=2, replies_per_post=0)) == [p1, p3]
    assert world.feed(limit=0) == []


async def test_feed_decays_with_rounds_and_prefers_newer_on_ties(world: SocialWorld):
    old = await world.create_post("a01", "old news")
    assert await world.like("a02", old)
    world.set_round(2)
    new = await world.create_post("a02", "new take")
    assert refs(world.feed()) == [old, new]  # 2/3^1.5 beats 1/2^1.5
    world.set_round(3)
    newer = await world.create_post("a03", "newest take")
    assert refs(world.feed()) == [newer, old, new]  # the old like has decayed
    twin = await world.create_post("a04", "same round, same engagement")
    assert refs(world.feed(limit=2)) == [twin, newer]


async def test_feed_shows_the_most_liked_replies_first(world: SocialWorld):
    post = await world.create_post("a01", "thread")
    c1 = await world.create_reply("a02", post, "first")
    c2 = await world.create_reply("a03", post, "second")
    c3 = await world.create_reply("a04", post, "third")
    for fan in ("a01", "a05"):
        assert await world.like(fan, c2)
    assert await world.like("a01", c3)
    assert refs(world.feed(replies_per_post=2)) == [post, c2, c3]
    assert refs(world.feed(replies_per_post=9)) == [post, c2, c3, c1]


async def test_feed_validates_its_arguments(world: SocialWorld):
    for kwargs in ({"limit": -1}, {"replies_per_post": -1}, {"limit": 1.5}, {"limit": True}):
        with pytest.raises(ValueError):
            world.feed(**kwargs)


async def test_likes_by_ref_counts_posts_and_replies(world: SocialWorld):
    post = await world.create_post("a01", "gm")
    reply = await world.create_reply("a02", post, "gm gm")
    quiet = await world.create_post("a03", "anyone?")
    assert world.likes_by_ref() == {post: 0, reply: 0, quiet: 0}
    for fan in ("a02", "a03", "a04"):
        assert await world.like(fan, post)
    assert await world.like("a01", reply)
    assert world.likes_by_ref() == {post: 3, reply: 1, quiet: 0}


async def test_all_content_keeps_creation_order_and_rounds(
    world: SocialWorld, crowd: list[AgentSpec]
):
    p1 = await world.create_post("a01", "round one post")
    c1 = await world.create_reply("a02", p1, "round one reply")
    world.set_round(2)
    p2 = await world.create_post("a03", "round two post")
    c2 = await world.create_reply("a04", c1, "reply to a reply")
    p3 = await world.create_post("a05", "another round two post")
    world.set_round(3)
    assert await world.like("a01", p2)
    world.set_round(4)
    c3 = await world.create_reply("a01", p3, "round four reply 中文 \U0001f680")

    content = world.all_content()
    assert refs(content) == [p1, c1, p2, c2, p3, c3]
    assert [post.round for post in content] == [1, 1, 2, 2, 2, 4]
    assert [post.reply_to for post in content] == [None, p1, None, p1, None, p3]
    assert [post.replies for post in content] == [2, 0, 0, 0, 1, 0]
    assert [post.likes for post in content] == [0, 0, 1, 0, 0, 0]
    assert content[-1].text == "round four reply 中文 \U0001f680"
    handles = {spec.agent_id: spec.handle for spec in crowd}
    for position, post in enumerate(content):
        assert post.author_handle == handles[post.author_agent_id]
        if post.reply_to is not None:
            assert refs(content).index(post.reply_to) < position
        Post.model_validate(post.to_run_dict())  # a valid run.json posts[] entry
    assert content[3].to_run_dict() == {
        "id": c2,
        "agentId": "a04",
        "text": "reply to a reply",
        "replyTo": p1,
        "likes": 0,
    }


async def test_posts_by_and_replies_to(world: SocialWorld):
    p1 = await world.create_post("a01", "a01 post")
    p2 = await world.create_post("a02", "a02 post")
    c1 = await world.create_reply("a02", p1, "a02 on a01's post")
    c2 = await world.create_reply("a01", c1, "a01 answers a02 in its own thread")
    c3 = await world.create_reply("a03", c2, "a03 answers a01's reply")
    c4 = await world.create_reply("a01", p2, "a01 on a02's post")
    c5 = await world.create_reply("a03", c4, "a03 answers a01 on a02's post")

    assert refs(world.posts_by("a01")) == [c4, c2, p1]
    assert refs(world.posts_by("a01", limit=2)) == [c4, c2]
    assert world.posts_by("a04") == []
    assert refs(world.replies_to("a01")) == [c5, c3, c1]
    assert refs(world.replies_to("a01", limit=1)) == [c5]
    assert refs(world.replies_to("a02")) == [c5, c4, c2]
    assert world.replies_to("a03") == []
    with pytest.raises(ValueError, match="unknown agent"):
        world.posts_by("a99")
    with pytest.raises(ValueError, match="unknown agent"):
        world.replies_to("a99")
    with pytest.raises(ValueError, match="limit"):
        world.replies_to("a01", limit=-1)


async def test_reads_are_fresh_and_never_write_to_oasis(world: SocialWorld):
    post = await world.create_post("a01", "gm")
    before = trace_rows(world)
    assert world.feed()[0].likes == 0
    world.posts_by("a01")
    world.replies_to("a01")
    world.likes_by_ref()
    world.all_content()
    assert trace_rows(world) == before  # unlike OASIS refresh(), reading leaves no trace
    assert await world.like("a02", post)
    assert world.feed()[0].likes == 1
    assert math.isclose(hot_score(world.feed()[0], 1), 2 / 2**1.5)
