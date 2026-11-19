import { Link, data } from "react-router";

import { Icon } from "~/components/ui";
import { PauseButton, ServicePill } from "~/components/services";
import { getService } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { machineLabel } from "~/lib/machine";
import { fmtWhen, serviceStatus } from "~/lib/status";
import type { ServiceJob } from "~/lib/types";

import type { Route } from "./+types/service";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.service.name ?? "Service"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const service = await getService(serverEnv().DB, params.id);
  if (!service) throw data("Service introuvable", { status: 404 });
  return { service, now: Date.now() };
}

const duration = (ms: number | null) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

function JobState({ job }: { job: ServiceJob }) {
  if (job.running) return <span className="ok">en cours</span>;
  return job.enabled ? <span>activé</span> : <span className="muted">désactivé</span>;
}

export default function ServicePage({ loaderData }: Route.ComponentProps) {
  const { service, now } = loaderData;
  const status = serviceStatus(service, now);
  const d = service.detail;
  const machine = machineLabel(service.machine);
  return (
    <div className="enter">
      <Link className="back" to="/services">
        <Icon name="left" />
        Services
      </Link>
      <div className="hero">
        <div className="hero-id">
          <h1>{service.name}</h1>
          <div className="hero-meta">
            <ServicePill status={status} />
            {service.group && <span>{service.group}</span>}
            <span>
              <Icon name="server" />
              {machine}
            </span>
          </div>
        </div>
        {service.pausable ? (
          <PauseButton big paused={service.paused} id={service.id} label={service.paused ? "Relancer" : "Mettre en pause"} />
        ) : (
          <span className="muted small">Surveillé seulement : pas de pause depuis Essaim.</span>
        )}
      </div>

      <div className="cols">
        <div className="col">
          <section className="panel" aria-labelledby="h-state">
            <div className="panel-head">
              <h2 id="h-state">En ce moment</h2>
            </div>
            {service.description && <p className="muted">{service.description}</p>}
            {status === "offline" && (
              <p className="svc-notice" style={{ "--c": "var(--err)" } as React.CSSProperties}>
                Le veilleur du {machine} ne donne plus de nouvelles depuis {fmtWhen(service.statusAt, now) || "toujours"} : l'état ci-dessous date de ce moment-là.
              </p>
            )}
            {d.pending && <p className="svc-notice">{d.pending}</p>}
            {!d.pending && (status === "pausing" || status === "resuming") && (
              <p className="svc-notice">{status === "pausing" ? "La pause sera appliquée au prochain relevé du veilleur." : "La reprise sera appliquée au prochain relevé du veilleur."}</p>
            )}
            {d.error && (
              <p className="svc-notice" style={{ "--c": "var(--err)" } as React.CSSProperties}>
                {d.error}
              </p>
            )}
            {d.summary && <p>{d.summary}</p>}
            {(d.counts ?? []).length > 0 && (
              <div className="svc-counts">
                {d.counts!.map((c) => (
                  <span key={c.label} className={c.tone === "warn" && c.value ? "warn" : ""}>
                    <b className="num">{c.value}</b>
                    {c.label}
                  </span>
                ))}
              </div>
            )}
          </section>

          {(d.jobs ?? []).length > 0 && (
            <section className="panel" aria-labelledby="h-jobs">
              <div className="panel-head">
                <h2 id="h-jobs">Tâches planifiées</h2>
              </div>
              <table className="svc-jobs">
                <thead>
                  <tr>
                    <th>Tâche</th>
                    <th>Planning</th>
                    <th>État</th>
                    <th>Dernier passage</th>
                  </tr>
                </thead>
                <tbody>
                  {d.jobs!.map((j) => (
                    <tr key={j.name}>
                      <td className="mono">{j.name}</td>
                      <td className="mono">{j.cron ?? ""}</td>
                      <td>
                        <JobState job={j} />
                      </td>
                      <td>
                        {j.lastAt ? (
                          <>
                            <span className={j.lastStatus === "ok" ? "ok" : "err"}>{j.lastStatus === "ok" ? "réussi" : j.lastStatus === "failed" ? "en échec" : (j.lastStatus ?? "?")}</span> {fmtWhen(j.lastAt, now)}
                            {j.durationMs != null && <span className="muted"> · {duration(j.durationMs)}</span>}
                          </>
                        ) : (
                          <span className="muted">jamais</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        <div className="col">
          <section className="panel" aria-labelledby="h-detail">
            <div className="panel-head">
              <h2 id="h-detail">Détails</h2>
            </div>
            <dl className="kv">
              {d.since && (
                <>
                  <dt>En service depuis</dt>
                  <dd>{fmtWhen(d.since, now)}</dd>
                </>
              )}
              {(d.facts ?? []).map((f) => (
                <FactRow key={f.label} label={f.label} value={f.value} at={f.at} atLabel={f.atLabel} tone={f.tone} now={now} />
              ))}
              {service.paused && service.pausedAt && (
                <>
                  <dt>En pause depuis</dt>
                  <dd>{fmtWhen(service.pausedAt, now)}</dd>
                </>
              )}
              <dt>Dernier relevé</dt>
              <dd>{service.statusAt ? fmtWhen(service.statusAt, now) : "jamais"}</dd>
              {service.version && (
                <>
                  <dt>Veilleur</dt>
                  <dd className="mono">{service.version}</dd>
                </>
              )}
              <dt>Identifiant</dt>
              <dd className="mono">{service.id}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function FactRow({ label, value, at, atLabel, tone, now }: { label: string; value: string; at?: string; atLabel?: string; tone?: string; now: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={tone ?? ""}>
        {value}
        {at && (
          <small>
            {atLabel ?? "depuis"} {fmtWhen(at, now)}
          </small>
        )}
      </dd>
    </>
  );
}
