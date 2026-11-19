import { useState } from "react";
import { data, Form, Link, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { getMachine, setMachinePlaces } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { DEFAULT_DURATION, DURATIONS, fmtBytes, fmtUntil, fmtUptime, machineLabel, MAX_CAPACITY, parseCapacity, suggestCapacity, untilFor, type MachineResources } from "~/lib/machine";
import { fmtTime, fmtWhen } from "~/lib/status";

import type { Route } from "./+types/machine";

export const meta: Route.MetaFunction = ({ params }) => [{ title: `${machineLabel(params.name)} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const env = serverEnv();
  const machine = await getMachine(env.DB, params.name);
  if (!machine) throw data("Cette machine ne s'est jamais connectée.", { status: 404 });
  return { machine, suggestion: suggestCapacity(machine.resources), now: Date.now() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const env = serverEnv();
  const machine = await getMachine(env.DB, params.name);
  if (!machine) throw data("Cette machine ne s'est jamais connectée.", { status: 404 });
  const form = await request.formData();
  if (form.get("intent") === "reset") {
    await setMachinePlaces(env.DB, machine.name, null, null);
    return { saved: Date.now() };
  }
  const capacity = parseCapacity(form.get("capacity"));
  if (capacity == null) return data({ error: `Choisis entre 1 et ${MAX_CAPACITY} places.` }, { status: 400 });
  // Revenir à la valeur par défaut sans échéance, c'est simplement effacer le réglage.
  const until = untilFor(form.get("duration"));
  if (capacity === machine.baseCapacity && !until) await setMachinePlaces(env.DB, machine.name, null, null);
  else await setMachinePlaces(env.DB, machine.name, capacity, until);
  return { saved: Date.now() };
}

const pct = (v: number | null | undefined) => (v == null ? null : Math.round(Math.min(1, Math.max(0, v)) * 100));

function Meter({ icon, label, ratio, value, detail }: { icon: string; label: string; ratio: number | null; value: string; detail?: string }) {
  const p = pct(ratio);
  const level = p == null ? "" : p >= 90 ? "hot" : p >= 70 ? "warm" : "";
  return (
    <div className={`meter ${level}`}>
      <div className="meter-head">
        <Icon name={icon} />
        <span>{label}</span>
        <b className="num">{value}</b>
      </div>
      <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p ?? undefined}>
        <i style={{ "--w": `${p ?? 0}%` } as React.CSSProperties} />
      </div>
      {detail && <span className="meter-detail">{detail}</span>}
    </div>
  );
}

function Resources({ r, online }: { r: MachineResources; online: boolean }) {
  const memUsed = r.memTotal && r.memAvailable != null ? r.memTotal - r.memAvailable : null;
  const diskUsed = r.diskTotal && r.diskFree != null ? r.diskTotal - r.diskFree : null;
  const runs = (r.runsRss ?? []).filter((n) => n > 0);
  const runsTotal = runs.reduce((a, b) => a + b, 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Ressources</h2>
        <span className="muted small">{online ? "en direct" : `relevé de ${fmtTime(r.at ?? null)}`}</span>
      </div>
      <div className="meters">
        <Meter
          icon="cpu"
          label="Processeur"
          ratio={r.cpuBusy ?? (r.load && r.cpus ? r.load[0] / r.cpus : null)}
          value={r.cpuBusy != null ? `${pct(r.cpuBusy)} %` : "—"}
          detail={`${r.cpus ?? "?"} cœurs${r.load ? ` · charge ${r.load.map((n) => n.toLocaleString("fr-FR")).join(" / ")}` : ""}`}
        />
        <Meter
          icon="memory"
          label="Mémoire"
          ratio={memUsed != null && r.memTotal ? memUsed / r.memTotal : null}
          value={`${fmtBytes(memUsed)} / ${fmtBytes(r.memTotal)}`}
          detail={`${fmtBytes(r.memAvailable)} disponibles`}
        />
        <Meter
          icon="disk"
          label="Disque"
          ratio={diskUsed != null && r.diskTotal ? diskUsed / r.diskTotal : null}
          value={`${fmtBytes(diskUsed)} / ${fmtBytes(r.diskTotal)}`}
          detail={`${fmtBytes(r.diskFree)} libres`}
        />
        <Meter
          icon="zap"
          label="Agents"
          ratio={r.memTotal && runs.length ? runsTotal / r.memTotal : 0}
          value={`${r.running ?? runs.length} au travail`}
          detail={
            runs.length
              ? `${fmtBytes(runsTotal)} en tout · ${fmtBytes(runsTotal / runs.length)} par run${r.chats ? ` · ${r.chats} discussion(s)` : ""}`
              : r.chats
                ? `${r.chats} discussion(s) ouverte(s)`
                : "aucun run en cours"
          }
        />
      </div>
      <p className="muted small">
        {[r.cpuModel, r.host, r.uptime ? `allumée depuis ${fmtUptime(r.uptime)}` : null].filter(Boolean).join(" · ")}
      </p>
    </section>
  );
}

export default function MachinePage({ loaderData, actionData }: Route.ComponentProps) {
  const { machine, suggestion, now } = loaderData;
  const nav = useNavigation();
  const current = machine.places ?? machine.baseCapacity ?? 1;
  const [value, setValue] = useState(current);
  const [base, setBase] = useState(current);
  // Nouvelle valeur venue du serveur (enregistrement, réglage expiré) : le curseur la suit.
  if (base !== current) {
    setBase(current);
    setValue(current);
  }
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const r = machine.resources;
  const isRunner = machine.baseCapacity != null || machine.capacity != null;
  const applied = machine.capacity === machine.places;
  const over = suggestion != null && value > suggestion.value;
  const error = actionData && "error" in actionData ? actionData.error : null;
  const saved = actionData && "saved" in actionData && value === current;
  const busy = nav.state === "submitting";
  const fill = ((value - 1) / (MAX_CAPACITY - 1)) * 100;

  return (
    <div className="enter machine-page">
      <Link className="back" to="/">
        <Icon name="left" />
        Accueil
      </Link>
      <div className="hero">
        <div className="machine-icon">
          <Icon name={machine.name === "nuc" ? "server" : "laptop"} />
        </div>
        <div className="hero-id">
          <h1>{machineLabel(machine.name)}</h1>
          <div className="hero-meta">
            <span>
              <i className={`led ${machine.online ? "" : "off"}`} aria-hidden="true" />
              {machine.online ? "En ligne" : `Hors ligne depuis ${fmtWhen(machine.lastSeen, now)}`}
            </span>
            {machine.version && <span className="mono">runner {machine.version}</span>}
            {r?.platform && (
              <span>
                {r.platform === "darwin" ? "macOS" : r.platform} · {r.arch}
              </span>
            )}
          </div>
        </div>
      </div>

      {isRunner ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Places</h2>
            {machine.override ? (
              <span className="tag-on">
                Réglage ponctuel{machine.override.until ? ` · jusqu'à ${fmtUntil(machine.override.until, now)}` : " · sans limite"}
              </span>
            ) : (
              <span className="muted small">Valeur par défaut du runner</span>
            )}
          </div>
          <p className="muted small">
            Nombre d'agents qui peuvent travailler en même temps sur cette machine. Les runs en cours ne sont jamais coupés : si tu baisses, la machine attend
            qu'ils finissent avant d'en lancer d'autres. Toutes les machines partagent le même quota d'abonnement.
          </p>
          <Form method="post" className="settings places-form">
            <div className="places-value">
              <output htmlFor="m-cap" className={`num ${over ? "over" : ""}`}>
                {value}
              </output>
              <span>place{value > 1 ? "s" : ""}</span>
              {machine.baseCapacity != null && value !== machine.baseCapacity && (
                <span className="muted small">par défaut : {machine.baseCapacity}</span>
              )}
            </div>
            <div className="places-slider" style={{ "--fill": `${fill}%` } as React.CSSProperties}>
              <input
                type="range"
                id="m-cap"
                name="capacity"
                min={1}
                max={MAX_CAPACITY}
                step={1}
                value={value}
                className={over ? "over" : ""}
                onChange={(e) => setValue(Number(e.target.value))}
                aria-label="Places"
                aria-valuetext={`${value} place${value > 1 ? "s" : ""}`}
              />
              {suggestion && (
                <span className="places-mark" style={{ "--at": (suggestion.value - 1) / (MAX_CAPACITY - 1) } as React.CSSProperties}>
                  conseillé : {suggestion.value}
                </span>
              )}
              {/* Bornes du curseur, cachées quand le repère du conseil tomberait dessus. */}
              <div className="places-scale num" aria-hidden="true">
                <span>{!suggestion || suggestion.value > 3 ? 1 : ""}</span>
                <span>{!suggestion || suggestion.value < MAX_CAPACITY - 2 ? MAX_CAPACITY : ""}</span>
              </div>
            </div>
            {suggestion && (
              <p className={`small ${over ? "warn-text" : "muted"}`} role={over ? "status" : undefined}>
                {over && <Icon name="alert" />}
                {over ? "Au-delà du conseil : la machine risque de ramer (ou de manquer de mémoire). " : ""}
                Conseil d'après {suggestion.limit === "memoire" ? "la mémoire disponible" : "le nombre de cœurs"} : {suggestion.value} place
                {suggestion.value > 1 ? "s" : ""} (≈ {fmtBytes(suggestion.perRun)} par run, {suggestion.measured ? "mesuré" : "estimé"}).
              </p>
            )}
            <fieldset className="field">
              <legend className="lbl">Pendant</legend>
              <input type="hidden" name="duration" value={duration} />
              <div className="seg" role="radiogroup" aria-label="Durée du réglage">
                {DURATIONS.map((d) => (
                  <button key={d.value} type="button" role="radio" aria-checked={duration === d.value} onClick={() => setDuration(d.value)}>
                    {d.label}
                  </button>
                ))}
              </div>
              <span className="help">
                {duration ? `Puis retour à ${machine.baseCapacity ?? "la valeur par défaut"} place(s).` : "Jusqu'à ce que tu reviennes à la valeur par défaut."}
              </span>
            </fieldset>
            {error && <span className="err">{error}</span>}
            <div className="row">
              <button className="btn primary" name="intent" value="places" disabled={busy}>
                Appliquer
              </button>
              {machine.override && (
                <button className="btn ghost" name="intent" value="reset" disabled={busy}>
                  Revenir à {machine.baseCapacity ?? "la valeur par défaut"}
                </button>
              )}
              {value !== current && (
                <button type="button" className="btn ghost" onClick={() => setValue(current)}>
                  Annuler
                </button>
              )}
              {saved && (
                <span className="saved" role="status">
                  <Icon name="check" /> {applied ? "Appliqué" : machine.online ? "Enregistré, le runner l'applique dans quelques secondes" : "Enregistré, appliqué au retour de la machine"}
                </span>
              )}
            </div>
          </Form>
        </section>
      ) : (
        <section className="panel">
          <h2>Places</h2>
          <p className="muted small">
            Pas de runner d'agents sur cette machine : seulement le veilleur de ses <Link to="/services">services</Link>.
          </p>
        </section>
      )}

      {r ? (
        <Resources r={r} online={machine.online} />
      ) : (
        <section className="panel">
          <h2>Ressources</h2>
          <p className="muted small">
            {isRunner
              ? "Le runner de cette machine n'envoie pas encore ses ressources (il se met à jour seul dans la demi-heure)."
              : "Le veilleur des services ne relève pas les ressources de cette machine."}
          </p>
        </section>
      )}
    </div>
  );
}
