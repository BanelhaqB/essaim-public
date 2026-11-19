import { listServices, openQuestionTasks } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { serviceStatus } from "~/lib/status";

/**
 * Ce qui attend le propriétaire, pour le badge de l'app macOS (desktop/) :
 * questions des agents et services en panne ou sans nouvelles.
 * Derrière Cloudflare Access comme le reste de l'interface.
 */
export async function loader() {
  const { DB } = serverEnv();
  const [questions, services] = await Promise.all([openQuestionTasks(DB), listServices(DB)]);
  const at = Date.now();
  const servicesDown = services.filter((s) => ["down", "offline"].includes(serviceStatus(s, at))).length;
  return Response.json(
    { questions: questions.length, servicesDown, total: questions.length + servicesDown },
    { headers: { "Cache-Control": "no-store" } },
  );
}
