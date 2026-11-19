import { Form, Link, NavLink, Outlet, useMatches, useNavigation } from "react-router";

import { RefreshButton } from "~/components/refresh";
import { ThemeToggle } from "~/components/theme";
import { BrandMark, Icon } from "~/components/ui";
import { getFocus, inboxTasks, latestQuota, listMachines, listServices, openQuestionTasks } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { usePolling } from "~/lib/use-polling";
import { machineLabel } from "~/lib/machine";
import { fmtTime, serviceStatus } from "~/lib/status";

import type { Route } from "./+types/layout";

export async function loader() {
  const { DB } = serverEnv();
  const [machines, focus, questions, inbox, services] = await Promise.all([listMachines(DB), getFocus(DB), openQuestionTasks(DB), inboxTasks(DB), listServices(DB)]);
  const at = Date.now();
  // Badge des services : ceux en panne ou dont le veilleur se tait.
  const servicesDown = services.filter((s) => ["down", "offline"].includes(serviceStatus(s, at))).length;
  return { machines, quota: latestQuota(machines), focus, questionCount: questions.length, inboxCount: inbox.length, servicesDown, now: at };
}

/** « 2/3 places » : runs en cours sur places ; « ↑ » quand le nombre vient d'un réglage ponctuel. */
function placesLabel(m: { places: number | null; override: unknown; resources: { running?: number } | null }) {
  const running = m.resources?.running;
  return `${running != null ? `${running}/` : ""}${m.places} place${m.places === 1 ? "" : "s"}${m.override ? " ↑" : ""}`;
}

const pct = (v?: number) => (typeof v === "number" ? Math.round(v * 100) : null);

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { machines, quota, focus, questionCount, inboxCount, servicesDown, now } = loaderData;
  usePolling(true, 10_000);
  const nav = useNavigation();
  // Pages pleine hauteur (conversation d'un agent) : la vue remplit l'écran sous la barre du haut.
  const full = useMatches().some((m) => (m.handle as { fullBleed?: boolean } | undefined)?.fullBleed);
  const blocked = Boolean(quota.blockedUntil && now < quota.blockedUntil);
  const five = pct(quota.fiveHour);
  const resets = quota.resetsAt ? fmtTime(quota.resetsAt * 1000) : null;

  const links = (
    <>
      <NavLink to="/" end>
        <Icon name="users" />
        <span>L'équipe</span>
        {questionCount > 0 && (
          <span className="badge num q" title={`${questionCount} question(s) en attente`}>
            {questionCount}
          </span>
        )}
      </NavLink>
      {inboxCount > 0 && (
        <NavLink to="/boite">
          <Icon name="inbox" />
          <span>À trier</span>
          <span className="badge num subtle">{inboxCount}</span>
        </NavLink>
      )}
      <NavLink to="/services">
        <Icon name="server" />
        <span>Services</span>
        {servicesDown > 0 && (
          <span className="badge num q" title={`${servicesDown} service(s) en panne ou sans nouvelles`}>
            {servicesDown}
          </span>
        )}
      </NavLink>
      <NavLink to="/agents/nouveau">
        <Icon name="plus" />
        <span>Nouvel agent</span>
      </NavLink>
      <NavLink to="/reglages">
        <Icon name="sliders" />
        <span>Réglages</span>
      </NavLink>
    </>
  );

  return (
    <>
      <div className="sky" aria-hidden="true" />
      <div className="app">
        <aside className="side" aria-label="Navigation principale">
          <Link className="brand" to="/">
            <BrandMark />
            <b>Essaim</b>
          </Link>
          <nav className="nav">{links}</nav>
          <div className="machines">
            <h2>Machines</h2>
            {machines.length === 0 && <p className="muted small">Aucun runner ne s'est encore connecté.</p>}
            {machines.map((m) => (
              <Link className="machine" key={m.name} to={`/machines/${m.name}`} title="Places et ressources">
                <Icon name={m.name === "nuc" ? "server" : "laptop"} />
                <div>
                  <b>{machineLabel(m.name)}</b>
                  <span>
                    {m.online ? (m.places != null ? `en ligne · ${placesLabel(m)}` : "en ligne") : `hors ligne depuis ${fmtTime(m.lastSeen)}`}
                  </span>
                </div>
                <i className={`led ${m.online ? "" : "off"}`} aria-label={m.online ? "en ligne" : "hors ligne"} />
              </Link>
            ))}
          </div>
        </aside>

        <div className={`main ${full ? "full" : ""}`}>
          <header className="top">
            <Link className="brand" to="/" aria-label="Essaim, accueil">
              <BrandMark />
            </Link>
            <div className={`quota ${blocked ? "limit" : ""}`} role="group" aria-label="Quota de l'abonnement">
              <Icon name="zap" />
              <div className="quota-body">
                <div className="quota-row num">
                  <span>{blocked ? "En attente" : "Quota (5 h)"}</span>
                  <span>
                    {blocked
                      ? `Limite atteinte · reprise vers ${fmtTime(quota.blockedUntil)}`
                      : five != null
                        ? `${five} %${resets ? ` · réinitialisation à ${resets}` : ""}${pct(quota.sevenDay) != null ? ` · semaine ${pct(quota.sevenDay)} %` : ""}`
                        : "pas encore mesuré"}
                  </span>
                </div>
                <div className="bar">
                  <i style={{ "--w": `${blocked ? 100 : (five ?? 0)}%` } as React.CSSProperties} />
                </div>
              </div>
            </div>
            <ThemeToggle />
            <Form method="post" action="/?index">
              <input type="hidden" name="intent" value="focus" />
              <input type="hidden" name="on" value={focus ? "0" : "1"} />
              <button className="focus-btn" aria-pressed={focus} disabled={nav.state === "submitting"} title="Les agents du Mac te laissent la place pendant que tu codes">
                <Icon name="headphones" />
                <span className="lbl">Je travaille</span>
              </button>
            </Form>
            <RefreshButton />
          </header>
          <main className="view">
            <Outlet />
          </main>
        </div>
      </div>
      <nav className="bnav" aria-label="Navigation">
        {links}
      </nav>
    </>
  );
}
