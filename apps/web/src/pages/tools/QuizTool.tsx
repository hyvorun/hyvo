import { PERSONAS } from "@hyvo/schema";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Arrow, PersonaIcon } from "../../components/Icons";
import { isArchetype, PROFILES, type Archetype } from "../../lib/archetypes";
import { QUESTIONS, scoreQuiz, type QuizResult } from "../../lib/quiz";
import { ToolPage, useDescription } from "./shared";
import quiz from "./Quiz.module.css";
import styles from "./Tools.module.css";

export function QuizTool() {
  useDescription("Which kind of trader are you? Ten quick questions match you to one of ten archetypes, from the sniper to the skeptic. Just for fun.");
  const [params, setParams] = useSearchParams();
  const [answers, setAnswers] = useState<number[]>([]);
  // A shared link opens on its result. Taken once: the address changes later, and not at once.
  const [shared, setShared] = useState<Archetype | null>(() => {
    const value = params.get("result");
    return isArchetype(value) ? value : null;
  });
  const result = answers.length === QUESTIONS.length ? scoreQuiz(answers) : null;
  const winner = result?.winner ?? null;

  // A finished quiz puts its result in the address, so the link can be shared.
  useEffect(() => {
    if (winner && params.get("result") !== winner) setParams({ result: winner }, { replace: true, preventScrollReset: true });
  }, [winner, params, setParams]);

  const restart = () => {
    setShared(null);
    setAnswers([]);
    setParams({}, { replace: true, preventScrollReset: true });
  };

  let body;
  if (result) body = <ResultCard result={result} onRestart={restart} />;
  else if (shared) body = <SharedResult persona={shared} onStart={restart} />
  else
    body = (
      <QuestionCard
        index={answers.length}
        onAnswer={(option) => setAnswers((current) => [...current, option])}
        onBack={answers.length > 0 ? () => setAnswers((current) => current.slice(0, -1)) : null}
      />
    );

  return (
    <ToolPage
      to="/tools/quiz"
      title="Which trader are you?"
      lede="Ten questions match you to one of the ten archetypes that Hyvo's synthetic crowds are made of. Just for fun: they describe behavior, and none of it is advice."
    >
      {body}
      <AllArchetypes current={winner} />
    </ToolPage>
  );
}

function QuestionCard({ index, onAnswer, onBack }: { index: number; onAnswer: (option: number) => void; onBack: (() => void) | null }) {
  const question = QUESTIONS[index]!;
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // Keyboard and screen reader users land on the new question after answering.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [index]);

  return (
    <section className={quiz.card} aria-labelledby="quiz-question">
      <div className={quiz.progress}>
        <span className="num">
          Question {index + 1} of {QUESTIONS.length}
        </span>
        <span className={quiz.bar} aria-hidden="true">
          <i style={{ width: `${(index / QUESTIONS.length) * 100}%` }} />
        </span>
      </div>
      <div key={index} className={quiz.question}>
        <h2 id="quiz-question" ref={heading} tabIndex={-1}>
          {question.prompt}
        </h2>
        <ul className={quiz.options}>
          {question.options.map((option, choice) => (
            <li key={option.text}>
              <button type="button" onClick={() => onAnswer(choice)}>
                <span className={quiz.letter} aria-hidden="true">
                  {String.fromCharCode(65 + choice)}
                </span>
                {option.text}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {onBack && (
        <button type="button" className={`btn btn-ghost btn-sm ${quiz.back}`} onClick={onBack}>
          Previous question
        </button>
      )}
    </section>
  );
}

function Profile({ persona, title }: { persona: Archetype; title: string }) {
  const profile = PROFILES[persona];
  return (
    <>
      <div className={quiz.who}>
        <span className={quiz.icon}>
          <PersonaIcon persona={persona} size={30} />
        </span>
        <div>
          <span className={quiz.kicker}>{title}</span>
          <h2>{profile.label}</h2>
        </div>
      </div>
      <p className={quiz.line}>{profile.line}</p>
      <dl className={quiz.profile}>
        <div>
          <dt>Goal</dt>
          <dd>{profile.goal}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>{profile.risk}</dd>
        </div>
        <div>
          <dt>Time horizon</dt>
          <dd>{profile.horizon}</dd>
        </div>
        <div>
          <dt>Reacts to</dt>
          <dd>
            <ul>
              {profile.reactsTo.map((trigger) => (
                <li key={trigger}>{trigger}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Posts like</dt>
          <dd>{profile.posts}</dd>
        </div>
      </dl>
    </>
  );
}

function ResultCard({ result, onRestart }: { result: QuizResult; onRestart: () => void }) {
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const label = PROFILES[result.winner].label;
  return (
    <section className={`${quiz.card} ${quiz.result}`} aria-label="Your result">
      <div ref={heading} tabIndex={-1} className={quiz.focusTarget}>
        <Profile persona={result.winner} title="You trade like a" />
      </div>
      <div className={quiz.mix}>
        <h3>Your answers</h3>
        <ul>
          {result.ranking.slice(0, 4).map((row) => (
            <li key={row.persona}>
              <span className={quiz.mixName}>
                <PersonaIcon persona={row.persona} size={13} /> {PROFILES[row.persona].label}
              </span>
              <span className={quiz.mixBar} aria-hidden="true">
                <i style={{ width: `${(row.count / QUESTIONS.length) * 100}%` }} />
              </span>
              <span className="num">
                {row.count} of {QUESTIONS.length}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <ShareRow text={`I trade like a ${label}. Which kind of trader are you?`} />
      <div className={quiz.actions}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRestart}>
          Take it again
        </button>
        <Link to="/runs" className="arrow-link" viewTransition>
          See the archetypes trade in a run <Arrow />
        </Link>
      </div>
      <p className={styles.fine}>Just for fun. The archetypes describe behavior, and none of this is advice.</p>
    </section>
  );
}

function SharedResult({ persona, onStart }: { persona: Archetype; onStart: () => void }) {
  return (
    <section className={`${quiz.card} ${quiz.result}`} aria-label="A shared result">
      <Profile persona={persona} title="Someone trades like a" />
      <div className={quiz.actions}>
        <button type="button" className="btn btn-primary" onClick={onStart}>
          Take the quiz
        </button>
      </div>
      <p className={styles.fine}>Just for fun. The archetypes describe behavior, and none of this is advice.</p>
    </section>
  );
}

function ShareRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : window.location.href;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A blocked clipboard: the address bar still has the link.
    }
  };
  return (
    <div className={quiz.share}>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy()}>
        {copied ? "Link copied" : "Copy the link to this result"}
      </button>
      {canShare && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.share({ title: "Which trader are you?", text, url }).catch(() => undefined);
          }}
        >
          Share
        </button>
      )}
      <span className={quiz.status} role="status">
        {copied ? "The link is on your clipboard." : ""}
      </span>
    </div>
  );
}

function AllArchetypes({ current }: { current: Archetype | null }) {
  return (
    <section className={quiz.all} aria-labelledby="quiz-all">
      <h2 id="quiz-all">The ten archetypes</h2>
      <ul>
        {PERSONAS.map((persona) => (
          <li key={persona} aria-current={persona === current ? "true" : undefined}>
            <PersonaIcon persona={persona} size={15} />
            <div>
              <b>{PROFILES[persona].label}</b>
              <span>{PROFILES[persona].line}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
