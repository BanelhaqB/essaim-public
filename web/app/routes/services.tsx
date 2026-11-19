import { Icon } from "~/components/ui";
import { PauseButton, ServiceCard, groupServices } from "~/components/services";
import { listServices } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { servicePauseAction } from "~/.server/services";

import type { Route } from "./+types/services";

export const meta: Route.MetaFunction = () => [{ title: "Services · Essaim" }];

export async function loader() {
  const { DB } = serverEnv();
  return { services: await listServices(DB), now: Date.now() };
}

export async function action({ request }: Route.ActionArgs) {
  return servicePauseAction(serverEnv().DB, await request.formData());
}

export default function Services({ loaderData }: Route.ComponentProps) {
  const { services, now } = loaderData;
  const groups = groupServices(services);
  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Services</h1>
          <p>Ce qui tourne en continu sur tes serveurs. Une pause s'applique sur la machine en moins d'une minute.</p>
        </div>
      </div>
      {services.length === 0 && (
        <div className="empty">
          <Icon name="server" />
          <p>
            Aucun service déclaré pour l'instant. Le veilleur d'un serveur les déclare tout seul une fois installé
            (<span className="mono">runner/install-services.sh</span>).
          </p>
        </div>
      )}
      {groups.map((g, gi) => {
        const pausable = g.services.filter((s) => s.pausable);
        const allPaused = pausable.length > 0 && pausable.every((s) => s.paused);
        return (
          <section className="section" key={g.name} aria-labelledby={`h-g${gi}`}>
            <div className="section-head">
              <Icon name="server" />
              <h2 id={`h-g${gi}`}>{g.name || "Sans groupe"}</h2>
              {pausable.length > 1 && (
                <div className="svc-group-actions">
                  <PauseButton paused={allPaused} group={g.name} label={allPaused ? "Tout relancer" : "Tout mettre en pause"} />
                </div>
              )}
            </div>
            <div className="grid">
              {g.services.map((s, i) => (
                <ServiceCard key={s.id} service={s} now={now} index={i} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
