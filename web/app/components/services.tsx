import { Link, useFetcher } from "react-router";

import { Icon } from "~/components/ui";
import { SERVICE_STATUS, fmtWhen, serviceStatus } from "~/lib/status";
import type { Service, ServiceStatus } from "~/lib/types";

export function ServicePill({ status }: { status: ServiceStatus }) {
  const s = SERVICE_STATUS[status] ?? SERVICE_STATUS.unknown;
  return (
    <span className={`pill ${status === "working" ? "live" : ""}`} style={{ "--c": s.color } as React.CSSProperties}>
      {s.label}
    </span>
  );
}

/**
 * Bouton pause / relance d'un service (id) ou de tout un groupe (group). Il passe par l'action de /services
 * sans quitter la page (accueil, liste ou détail), qui se recharge ensuite.
 */
export function PauseButton({ paused, id, group, label, big = false }: { paused: boolean; id?: string; group?: string; label: string; big?: boolean }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  // Affichage immédiat de la demande, avant le rechargement.
  if (busy && fetcher.formData) paused = fetcher.formData.get("intent") === "pause";
  const intent = paused ? "resume" : "pause";
  return (
    <fetcher.Form method="post" action="/services" className={big ? "hero-actions" : "svc-pause"}>
      {id && <input type="hidden" name="id" value={id} />}
      {group && <input type="hidden" name="group" value={group} />}
      {big || group ? (
        <button className={`btn ${big ? "" : "small ghost"} ${paused ? "primary" : ""}`} name="intent" value={intent} disabled={busy}>
          <Icon name={paused ? "play" : "pause"} />
          {label}
        </button>
      ) : (
        <button className="icon-btn" name="intent" value={intent} aria-label={label} title={label} disabled={busy}>
          <Icon name={paused ? "play" : "pause"} />
        </button>
      )}
    </fetcher.Form>
  );
}

export function ServiceCard({ service, now, index }: { service: Service; now: number; index: number }) {
  const status = serviceStatus(service, now);
  const d = service.detail;
  return (
    <article className={`acard scard stagger ${status === "working" ? "is-working" : ""}`} style={{ "--h": 265, "--i": index } as React.CSSProperties}>
      <Link className="acard-link" to={`/services/${service.id}`} aria-label={`Ouvrir ${service.name}`} />
      <div className="acard-top">
        <span className="svc-ico" aria-hidden="true">
          <Icon name="server" />
        </span>
        <div className="acard-id">
          <h3>{service.name}</h3>
          <span className="mono">{service.group || service.machine.toUpperCase()}</span>
        </div>
        {service.pausable && (
          <PauseButton paused={service.paused} id={service.id} label={`${service.paused ? "Relancer" : "Mettre en pause"} ${service.name}`} />
        )}
      </div>
      <ServicePill status={status} />
      <div className="acard-now">{d.pending ?? d.error ?? d.summary ?? ""}</div>
      <footer className="acard-foot">
        {(d.counts ?? []).slice(0, 2).map((c) => (
          <span key={c.label} className={c.tone === "warn" && c.value ? "warn" : ""}>
            {c.value} {c.label.toLowerCase()}
          </span>
        ))}
        <span className="svc-seen">{service.statusAt ? `relevé ${fmtWhen(service.statusAt, now)}` : "jamais relevé"}</span>
      </footer>
    </article>
  );
}

/** Les services rangés par groupe, dans l'ordre de la machine. */
export function groupServices(services: Service[]) {
  const groups = new Map<string, Service[]>();
  for (const s of services) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return [...groups.entries()].map(([name, list]) => ({ name, services: list }));
}
