"""Post, reply and reason templates of the offline policy, by persona and situation.

In-character crowd chatter in the first person. The wording never addresses or advises the
reader, never uses the words "buy", "sell", "will", "should", "must" or "guarantee", and never
names a price target, so a filled template can never trip the copy guard (``hyvo.report.guard``).

Placeholders: ``{round}``, ``{rounds}``, ``{chg}`` (price change last round), ``{start}`` (since
the start), ``{drop}`` / ``{rise}`` (size of a negative / positive ``chg``), ``{holders}``,
``{price}``, ``{pool}`` (ETH in the pool), ``{buys}`` / ``{sells}`` (recent swaps), ``{amt}`` (ETH
of this agent's swap_buy), ``{pct}`` (share sold), ``{pnl}`` (signed ETH) and ``{handle}`` (the
author replied to).

Situations: trade keys (``early``, ``dip``, ``fear_drop``...) are used only by the persona whose
policy makes that trade, so ``{amt}``, ``{pct}``, ``{drop}`` and ``{rise}`` always fit. Hold moods
are ``green`` / ``red`` (the price rose / fell last round) and ``bull`` / ``bear`` (no clear move);
a missing ``green`` or ``red`` falls back to ``bull`` or ``bear``. The policy skips a template
whose ``{chg}``, ``{start}``, ``{buys}`` or ``{sells}`` would be zero, so every situation keeps at
least one template without them.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

Templates = Mapping[str, tuple[str, ...]]

FALLBACK = {"green": "bull", "red": "bear"}

SNIPER: Templates = {
    "early": (
        "Going in at round {round} with {amt} ETH. Fresh pool, thin liquidity, early wallets eat first.",
        "Aping {amt} ETH before the crowd shows up. Only {pool} ETH in the pool.",
        "Entering with {amt} ETH while it is this early. Early is the whole game.",
        "Sniped a {amt} ETH bag while the feed was still asleep.",
        "First rounds are where the fun is. {amt} ETH in, eyes already on the exit.",
    ),
    "momentum": (
        "{buys} buys vs {sells} sells in the last swaps. Adding {amt} ETH to ride the momentum.",
        "Chasing this one with {amt} ETH. Volume is waking up.",
        "Momentum is real: {chg} last round. Jumped in with {amt} ETH.",
        "Another {amt} ETH in. Pool still thin at {pool} ETH, moves come fast.",
    ),
    "profit": (
        "Taking profit: selling {pct} with {pnl} on the trade. Thanks for the liquidity.",
        "Out with {pnl}. {start} since launch was enough for me.",
        "Scaled out {pct}. I don't marry bags, I date them for a round or two.",
        "Selling {pct} into strength. Back to hunting fresh pools.",
    ),
    "cut": (
        "Cutting it, {pct} goes. Not riding a pullback.",
        "Stopped out. PnL {pnl}, moving on to the next pool.",
        "Exiting {pct} right here. Fast in, fast out.",
        "Out. This one lost its spark for me.",
    ),
    "green": (
        "{chg} last round and the feed is loud. Bag still on.",
        "{buys} buys in the recent swaps, nobody is leaving yet.",
    ),
    "bull": (
        "Still riding this one. {holders} holders and plenty of eyes on it.",
        "Not touching my position yet. {start} since start.",
        "Watching the flow, bag still on.",
    ),
    "red": (
        "This stalled. {chg} last round, finger on the exit.",
        "{chg} and the flow turned. One more red round and I'm gone.",
    ),
    "bear": (
        "Liquidity looks tired. Waiting for a reason to care again.",
        "Quiet chart, quiet me. Round {round} of {rounds}.",
    ),
    "news_up": (
        "News just hit and I was already positioned. Round {round} is getting interesting.",
        "Headlines like that bring the crowd. Watching the swaps closely.",
    ),
    "news_down": (
        "Saw the news. Not sticking around long to find out if it's true.",
        "That headline smells like an exit wave. Watching every swap.",
    ),
    "checking": ("Pulling up the pool numbers before my next move.",),
    "checked": ("Pool check: {pool} ETH deep, {holders} holders. Thin enough to move fast.",),
    "reply_bull": (
        "{handle} early wallets know. Pool is still only {pool} ETH.",
        "{handle} same read here. {buys} buys in the last swaps.",
        "{handle} the feed is waking up, I'm watching the same flow.",
    ),
    "reply_bear": (
        "{handle} sounds like round one doubt. {start} since start says otherwise so far.",
        "{handle} fair, but I'm out the moment it stalls anyway.",
    ),
}

HOLDER: Templates = {
    "dip": (
        "Adding {amt} ETH on this dip. {drop} in a round doesn't change what the team has shown so far.",
        "We've seen shakeouts before. Picking up a little more ({amt} ETH), then back to reading the docs.",
        "Small add of {amt} ETH while the feed panics. Conviction comes from the work, not the candle.",
        "Red round, quiet add: {amt} ETH. Nothing about the project changed in the last hour.",
    ),
    "build": (
        "Started a position with {amt} ETH. Planning to sit with it for weeks and watch the community grow.",
        "Accumulating slowly, {amt} ETH this round. {holders} holders is the number I care about.",
        "Opening a long-term bag with {amt} ETH. We're early, and early means patient.",
    ),
    "news": (
        "That update is the kind of progress we wanted. Adding {amt} ETH and staying put.",
        "Real progress in the news. Topping up {amt} ETH, nothing fancy.",
    ),
    "evidence": (
        "I've defended this for {round} rounds, but this news is different. Trimming {pct} until the team explains.",
        "Hard post to write: reduced my position by {pct}. Credible risk is the one thing I don't hold through.",
        "Taking {pct} off. Not panic, just respecting the evidence until we hear from the team.",
    ),
    "green": (
        "Green round ({chg}), but I'd be holding either way.",
        "Nice to see {chg}. The work matters more than the candle, but I'll take it.",
    ),
    "bull": (
        "Still holding. {start} since start is noise next to where this community could be in a few weeks.",
        "Nothing changed for me this round. The team keeps shipping, we keep holding.",
        "{holders} holders now. Slow and steady is how real communities form.",
        "Zooming out: round {round} of {rounds} and the feed gets busier every time.",
    ),
    "red": (
        "Red rounds test conviction. {chg} this round and my thesis didn't move.",
        "We've had worse rounds than {chg}. Holding and waiting for the next team update.",
    ),
    "bear": (
        "Lots of fear in the feed today. I'm reading it, not reacting to it.",
        "Price is {start} since start and people are loud about it. Still here.",
        "Quiet stretch. Holding and waiting for the next team update.",
    ),
    "news_up": (
        "Good to see real progress this round. This is why we hold.",
        "That's the update the community was waiting for. Calm and holding.",
    ),
    "news_down": (
        "That rumor needs a source. Until the team answers, I'm not moving.",
        "Unconfirmed news, loud feed. Waiting for facts before I change anything.",
    ),
    "checking": ("Taking a proper look at the pool before I add anything.",),
    "checked": (
        "Looked at the pool properly: {pool} ETH of liquidity and {holders} holders. Healthier than the feed suggests.",
    ),
    "reply_bull": (
        "{handle} love the energy. Patience is the edge here.",
        "{handle} agreed, and the community feels stronger every round.",
    ),
    "reply_bear": (
        "{handle} fair question. I judge the team's work, not one candle.",
        "{handle} doubts are healthy, but {holders} holders didn't show up by accident.",
        "{handle} I hear you. The answers are in what the team ships, not in the chart.",
        "{handle} we've had red rounds before. Still here, still holding.",
    ),
}

PANIC_SELLER: Templates = {
    "fear_drop": (
        "Is anyone else seeing this?? {drop} down in one round. Selling {pct} and I'm shaking.",
        "NOPE. {chg} this round. Getting out of {pct} of my bag.",
        "Why is it bleeding?? Dumping {pct}, can't watch this.",
    ),
    "fear_news": (
        "That rumor scared me. Selling {pct} before anyone can confirm it.",
        "If the news is true we're cooked. Out with {pct}, sorry not sorry.",
        "SELLING {pct}. Not waiting around to find out if the headline is real.",
    ),
    "fear_loss": (
        "My position hit {pnl} and I'm panicking. Selling {pct} so I can sleep.",
        "OK I'm bailing on {pct} here. Somebody tell me this isn't the bottom.",
        "Down {pnl} on this and my stomach hurts. Getting out of {pct}.",
    ),
    "fomo": (
        "Fine, I'm back with a tiny {amt} ETH. It climbed {rise} and I hate missing out.",
        "Re-entering small, {amt} ETH. If it drops again I'm gone again.",
        "Back in with {amt} ETH after watching it climb. Nervous though.",
    ),
    "green": ("Phew, green round ({chg}). Still nervous but holding for now.",),
    "bull": (
        "OK this looks better. {holders} holders and nobody is running for the exit yet.",
        "Calmer feed today. Still have my finger on the exit though.",
    ),
    "red": (
        "Why is it red?? {chg} this round. Is something happening?",
        "{sells} sells in the recent swaps, that's a lot right?? Not sure about this anymore.",
        "Everyone went quiet and the chart is {chg}. That's never a calm sign, right?",
    ),
    "bear": (
        "My position is {pnl} and I'm sweating. Anyone have info?",
        "Not sure about this anymore. Something feels off.",
        "Can't stop refreshing. Is everyone else calm about this??",
    ),
    "news_up": ("Good news for once. Still checking the pool every five minutes.",),
    "news_down": (
        "WAIT. Did everyone see the news?? This is how it starts.",
        "If that rumor is true we're cooked. Checking every swap now.",
        "Rumors in the feed and my hands are shaking. Anyone know more??",
    ),
    "checking": ("Refreshing the pool numbers again. Can't stop looking.",),
    "checked": ("Checked the pool again: {pool} ETH in it and {holders} holders. Is that a lot or a little??",),
    "reply_bull": (
        "{handle} how are you this calm? My hands are shaking.",
        "{handle} hope you're right, I really do.",
    ),
    "reply_bear": (
        "{handle} wait, is that confirmed?? Seeing {chg} on my side too.",
        "{handle} this is exactly what scares me. Anyone know more?",
        "{handle} I KNEW something was off.",
    ),
}

SKEPTIC: Templates = {
    "starter": (
        "Opening a tiny position, {amt} ETH. {holders} wallets is enough to earn a closer look, not trust.",
        "Small starter of {amt} ETH. Still skeptical, just paying closer attention now.",
    ),
    "trim": (
        "Trimming {pct} of my small position. The numbers stopped making sense.",
        "Reduced exposure by {pct}. Concentration risk is not a theory.",
    ),
    "green": (
        "A {chg} round on thin liquidity says little about real demand.",
        "Credit where due, {buys} buys in the recent swaps. Not convinced, but paying attention.",
    ),
    "bull": ("Fine, activity looks broader than I expected: {holders} holders. Still want to see the contract.",),
    "red": ("{chg} on a pool with {pool} ETH. Thin pools swing hard in both directions.",),
    "bear": (
        "{holders} holders after {round} rounds. Who holds the top wallets? Nobody has shown the distribution.",
        "Price is {start} since start on a pool with {pool} ETH. Thin pools make any chart look exciting.",
        "Still no answer on the fee structure. Until then I'm watching, not trading.",
        "{buys} buys and {sells} sells in the recent swaps. Not exactly broad demand.",
        "Every claim in this scenario is unverified. Where is the source?",
        "Interesting how the loudest posts come from wallets that got in first.",
    ),
    "news_up": (
        "Nice headline. Show me the contract, the audit report and who signed it.",
        "Headlines are cheap. Let's see if {holders} holders turns into actual usage.",
    ),
    "news_down": (
        "This is the red flag I mentioned. Concentrated holdings plus that news is a bad mix.",
        "Unverified news moving a thin pool. This is exactly the setup I keep warning about.",
    ),
    "checking": ("Pulling the pool numbers myself instead of trusting the feed.",),
    "checked": ("Checked the pool myself: {pool} ETH and {holders} holders. The numbers are thinner than the hype.",),
    "reply_bull": (
        "{handle} what exactly is driving this besides the chart? {holders} holders is not a community yet.",
        "{handle} {start} since start on {pool} ETH of liquidity. Let's see it hold through a real exit wave.",
        "{handle} confidence is not evidence. Who audited it?",
        "{handle} hype noted. The swaps show {buys} buys and {sells} sells, thinner than the posts suggest.",
    ),
    "reply_bear": (
        "{handle} agreed. The distribution question still has no answer.",
        "{handle} same concern here. Nobody has explained the dev wallet.",
    ),
}

SWING_TRADER: Templates = {
    "pullback": (
        "Took {amt} ETH on this {drop} pullback. The level is what I care about, not the story.",
        "Pullback of {drop}, in with {amt} ETH. If the low goes, I go.",
        "Waited for the red round. {amt} ETH at this level.",
    ),
    "stall": (
        "Stalling after {start}. Trimmed {pct} and waiting for the next range.",
        "No follow-through up here. Let go of {pct}.",
        "Range top behavior. {pct} off, the rest stays.",
    ),
    "green": ("{chg} last round. Not chasing it, waiting for a pullback.",),
    "bull": ("Sitting on my hands until there is a level to work with.", "No setup this round. {start} since start."),
    "red": ("{chg} last round. Watching whether the low holds.",),
    "bear": ("Volume is thin at {pool} ETH. No setup, so no trade.", "Round {round}: chop. Stepping aside."),
    "news_up": ("Headline noted. The chart still has to confirm it.",),
    "news_down": ("Headline noted. Watching which level gives way first.",),
    "checking": ("Pulling the pool numbers to mark the levels.",),
    "checked": ("Pool is {pool} ETH deep, so a small swap moves it. Sizing for that.",),
    "reply_bull": ("{handle} maybe. Show me a higher low first.",),
    "reply_bear": ("{handle} the chart has not said that yet. Watching the low.",),
}

WHALE: Templates = {
    "pieces_in": ("Took a piece.", "A little more, {amt} ETH.", "Adding in pieces."),
    "pieces_out": ("Took a piece off.", "Lighter by {pct}.", "Reducing, slowly."),
    "green": ("Fine.",),
    "bull": ("Watching.", "No hurry."),
    "red": ("Seen worse.",),
    "bear": ("Quiet is fine.",),
    "news_up": ("Noted.",),
    "news_down": ("Noted. Watching the depth.",),
    "checking": ("Checking the depth.",),
    "checked": ("{pool} ETH in the pool. Thin for my size.",),
    "reply_bull": ("{handle} perhaps.",),
    "reply_bear": ("{handle} perhaps.",),
}

KOL_FOLLOWER: Templates = {
    "followed_in": (
        "Everyone on my feed is talking about this, so I'm in with {amt} ETH. Am I too late?",
        "The popular accounts are on it. Joined with {amt} ETH.",
        "Saw the likes pile up and jumped in, {amt} ETH.",
    ),
    "followed_out": (
        "The feed turned on this one, so I'm out of {pct}. Not staying where the loud accounts left.",
        "If the big accounts are nervous, so am I. {pct} gone.",
    ),
    "green": ("{chg} and my whole feed is excited. This is fun.",),
    "bull": ("Everyone I follow is watching this. Staying close.", "What are the top posts saying now?"),
    "red": ("{chg}. What are the big accounts saying? Anyone?",),
    "bear": ("The feed went quiet. Waiting for someone to say what this means.",),
    "news_up": ("Big news, and the feed is lighting up. Who posted it first?",),
    "news_down": ("Everyone is reposting that news. What's the take from the big accounts?",),
    "checking": ("Checking the pool since everyone keeps quoting it.",),
    "checked": ("{holders} holders, like the posts said.",),
    "reply_bull": ("{handle} this. Exactly this.", "{handle} you called it, I'm following you on this one."),
    "reply_bear": ("{handle} wait, are you out? Now I'm worried.", "{handle} you usually see these things first. Now I'm nervous."),
}

MARKET_MAKER_BOT: Templates = {
    "rebalance_up": ("Rebalance: +{amt} ETH of exposure after {chg}.",),
    "rebalance_down": ("Rebalance: -{pct} of tokens after {chg}.",),
    "bull": ("Status: inventory in range. Round {round}.",),
    "bear": ("Status: inventory in range. Round {round}.",),
    "news_up": ("Status: no change to parameters.",),
    "news_down": ("Status: no change to parameters.",),
    "checking": ("Status: reading pool state.",),
    "checked": ("Status: pool {pool} ETH, {holders} holders.",),
    "reply_bull": ("{handle} status: no opinion.",),
    "reply_bear": ("{handle} status: no opinion.",),
}

STOCK_TOKEN_HOLDER: Templates = {
    "side_bet": (
        "A small side bet of {amt} ETH, next to what I actually hold. Let's see what this is.",
        "Put {amt} ETH on it. Money I can treat as tuition.",
    ),
    "side_bet_out": (
        "That was enough of a side bet. {pct} gone, back to my portfolio.",
        "I know what I own and why. This one I don't. Out of {pct}.",
    ),
    "green": ("{chg} is a nice round. What does the token actually do, though?",),
    "bull": ("In my portfolio I can read the revenue. Where do I read it here?", "Still curious, still mostly watching."),
    "red": ("{chg} in a round. My other holdings do that in a year.",),
    "bear": ("Hard to value something with {holders} holders and no cash flow.", "Nothing here I'd explain to my accountant."),
    "news_up": ("Good news is good. How does it reach the token holder, though?",),
    "news_down": ("This is why my main holdings are elsewhere.",),
    "checking": ("Reading the numbers before forming a view.",),
    "checked": ("Pool of {pool} ETH. That's thin next to what I usually hold.",),
    "reply_bull": ("{handle} and what is it worth, in your view? Based on what?",),
    "reply_bear": ("{handle} agreed, the fee structure is the first thing I'd ask about.",),
}

NEWCOMER: Templates = {
    "joining": (
        "First time doing this! Put in {amt} ETH because it's been going up. Is that how this works?",
        "OK I'm in with {amt} ETH. It went up {start} already, so I hope I'm not too late.",
        "Trying it with {amt} ETH. Tiny amount, I'm still learning.",
    ),
    "fright": (
        "I don't understand what just happened, so I took out {pct}. Is that normal?",
        "It dropped and got scary. Took out {pct}. I'll read up first.",
    ),
    "green": ("{chg} last round! Is that a lot? It feels like a lot.",),
    "bull": ("Learning a lot from this feed. What does slippage mean, exactly?", "What is a tax on a swap? Is that why I got less?"),
    "red": ("{chg}. Is it supposed to do that? Nobody told me about this part.",),
    "bear": ("I'm a bit lost, to be honest. Where do people learn this?", "Why did I get fewer tokens than the screen showed?"),
    "news_up": ("Is this news good? Everyone seems happy.",),
    "news_down": ("Is this news bad? Everyone sounds worried now.",),
    "checking": ("Trying to read the pool numbers. Not sure what I'm looking at.",),
    "checked": ("{pool} ETH in the pool and {holders} holders. Is that a lot?",),
    "reply_bull": ("{handle} how did you know that? I'm new here.", "{handle} thanks, that helps. I'm still figuring this out."),
    "reply_bear": ("{handle} wait, why is that bad? Sorry, new here.", "{handle} oh no. What am I missing?"),
}

CLONE: Templates = {
    "by_its_record_in": ("Took {amt} ETH, about the size I take.", "In with {amt} ETH. About where I come in."),
    "by_its_record_out": ("Let go of {pct}, about what I let go at once.", "Out of {pct}. That is my pace."),
    "bull": ("Holding. Nothing to do yet by my numbers.", "Still in. That is what I do at this point."),
    "bear": ("Not my kind of setup. Waiting.", "My numbers say wait."),
    "news_up": ("News. Watching what the pool does with it.",),
    "news_down": ("Bad news, if true. Watching the swaps.",),
    "checking": ("Reading the pool.",),
    "checked": ("{pool} ETH in the pool, {holders} holders.",),
    "reply_bull": ("{handle} noted.",),
    "reply_bear": ("{handle} noted, thanks.",),
}

DEFAULT: Templates = {
    "bull": ("Watching this one with interest. {holders} holders so far.",),
    "bear": ("Not sure what to make of round {round}. Noisy feed.",),
    "news_up": ("Interesting update this round. Watching how the crowd reacts.",),
    "news_down": ("That news changes the mood. Watching closely.",),
    "checking": ("Checking the pool before deciding anything.",),
    "checked": ("Pool has {pool} ETH and {holders} holders right now.",),
    "reply_bull": ("{handle} interesting take. Watching the same numbers.",),
    "reply_bear": ("{handle} fair point, hard to ignore.",),
}

POSTS: Mapping[str, Templates] = MappingProxyType(
    {
        "sniper": SNIPER,
        "holder": HOLDER,
        "panic_seller": PANIC_SELLER,
        "skeptic": SKEPTIC,
        "swing_trader": SWING_TRADER,
        "whale": WHALE,
        "kol_follower": KOL_FOLLOWER,
        "market_maker_bot": MARKET_MAKER_BOT,
        "stock_token_holder": STOCK_TOKEN_HOLDER,
        "newcomer": NEWCOMER,
        "clone": CLONE,
    }
)

REASONS: Templates = {
    "early": ("fresh pool, early entry", "first rounds of a thin pool"),
    "momentum": ("momentum: {chg} last round", "volume picking up"),
    "dip": ("dip of {drop} looks temporary", "adding on weakness, thesis unchanged"),
    "build": ("building a long-term position", "early accumulation"),
    "news": ("progress in the news", "the update supports the thesis"),
    "fomo": ("price recovered {rise}, re-entering small", "fear of missing the recovery"),
    "starter": ("broad activity earns a small position",),
    "profit": ("taking profit on the run-up", "run-up reached, scaling out"),
    "cut": ("momentum faded, cutting the position", "no reason left to stay"),
    "evidence": ("the news looks like credible risk", "reducing exposure until the team explains"),
    "fear_drop": ("price fell {drop} this round", "the drop scared me"),
    "fear_news": ("scary news this round", "rumors make me nervous"),
    "fear_loss": ("position is at {pnl}", "cannot stand the loss"),
    "trim": ("red flags outweigh the upside", "concentration risk"),
    "pullback": ("a pullback of {drop} to work with", "the level looks usable"),
    "stall": ("stalling after the run-up", "no follow-through"),
    "pieces_in": ("the pool can take a piece", "entering slowly"),
    "pieces_out": ("reducing in pieces", "the run-up lets me lighten up"),
    "followed_in": ("the popular posts are excited", "following the feed"),
    "followed_out": ("the feed turned", "the loud accounts are nervous"),
    "rebalance_up": ("price fell, inventory below target",),
    "rebalance_down": ("price rose, inventory above target",),
    "side_bet": ("a small side bet on the news",),
    "side_bet_out": ("this side bet stopped making sense",),
    "joining": ("it has been going up", "wanted to try it"),
    "fright": ("got scared by the move", "I do not understand what happened"),
    "by_its_record_in": ("about the size and timing on record",),
    "by_its_record_out": ("about the holding time on record",),
    "check": ("want the full pool numbers first", "checking before acting"),
    "broke": ("not enough ETH left for a swap",),
    "hold_bull": ("nothing this round changes my view", "comfortable where I am"),
    "hold_bear": ("watching, no edge yet", "not convinced either way"),
}
