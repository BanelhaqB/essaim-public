import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/layout.tsx", [
    index("routes/home.tsx"),
    route("agents/nouveau", "routes/agent-new.tsx"),
    route("agents/:id", "routes/agent.tsx"),
    route("agents/:id/taches/:taskId", "routes/task.tsx"),
    route("agents/:id/memoire", "routes/memory.tsx"),
    route("agents/:id/reglages", "routes/agent-settings.tsx"),
    route("agents/:id/actions", "routes/actions.tsx"),
    route("projets", "routes/projets.tsx"),
    route("projets/:id", "routes/projet.tsx"),
    route("repos", "routes/repos.tsx"),
    route("repos/nouveau", "routes/repo-new.tsx"),
    route("repos/:id", "routes/repo.tsx"),
    route("boite", "routes/inbox.tsx"),
    route("services", "routes/services.tsx"),
    route("services/:id", "routes/service.tsx"),
    route("machines/:name", "routes/machine.tsx"),
    route("reglages", "routes/settings.tsx"),
  ]),
  // Compteur du badge de l'app macOS (JSON, hors de la mise en page).
  route("badge", "routes/badge.ts"),
  // Bouton « Actualiser » : synchro immédiate des runners (action seule).
  route("actualiser", "routes/refresh.ts"),
] satisfies RouteConfig;
