# Essaim

Des agents Claude Code qui traitent tes tickets GitHub en autonomie, jour et nuit, avec ton abonnement Claude
(pas l'API). Un agent = un repo : il prend une à une les tâches de sa file, rédigées et ordonnées dans Essaim, ouvre
une PR (et merge, déploie ou publie si tu l'y autorises), pose ses questions sans s'arrêter, te prévient sur Telegram,
et reprend tout seul quand la limite de l'abonnement se réinitialise.

L'interface est en français. Elle tourne sur **ton** compte Cloudflare ; les agents tournent sur **ton** Mac.

```
            ┌──────────────────── Cloudflare (ton compte) ────────────────────┐
 toi ──────▶│ Access ▶ Worker « essaim » (web/) : interface · D1 · cron 5 min  │◀──── Telegram (webhook, facultatif)
 (navigateur│          Durable Object « Hub » : temps réel                      │────▶ Telegram (notifications)
  ou app    └───────────────▲──────────────────────────────────────────────────┘
  macOS)                    │ HTTPS + WebSocket sortants (Bearer RUNNER_TOKEN)
            ┌───────────────┴───────────────┐     ┌─────────────────────────────────┐
            │ Ton Mac : runner/              │     │ Un serveur Linux (facultatif) :  │
            │  claude -p · gh · git          │     │  veilleur des services, pause    │
            │  un worktree par tâche         │     └─────────────────────────────────┘
            └────────────────────────────────┘
```

- **web/** : le plan de contrôle (Worker Cloudflare, React Router 7, base D1). Il garde l'état et le montre ; il ne
  lance rien lui-même.
- **runner/** : Node 24 sans dépendance. Il tourne sur la machine qui exécute (ton Mac), parle au Worker et fait
  travailler Claude Code.
- **desktop/** : l'app macOS (facultative), une fenêtre native autour de l'interface.

Pour installer Essaim avec l'aide d'une IA (Claude Code, par exemple), donne-lui
[`INSTALLATION-IA.md`](INSTALLATION-IA.md) : c'est la même procédure, écrite pour qu'elle la déroule avec toi de A à Z.

---

## Ce qu'il te faut

| | Pourquoi | Coût |
|---|---|---|
| **Compte Cloudflare** | Héberge l'interface et l'API (Workers, D1, Durable Objects, Cron) et la protège (Cloudflare Access, Zero Trust) | Offres gratuites suffisantes (Zero Trust Free : 50 utilisateurs) |
| **Un domaine sur ce compte** | L'interface vit sur un sous-domaine (`essaim.ton-domaine.fr`) protégé par Access. Le domaine doit être une zone **active** du compte (achat chez Cloudflare Registrar, ou serveurs DNS pointés sur Cloudflare) | Le prix du domaine |
| **Compte GitHub** + [`gh`](https://cli.github.com) connecté (`gh auth login`) | Repos des agents, issues miroir, PR | Gratuit |
| **Abonnement Claude** (Pro ou Max) + [Claude Code](https://docs.claude.com/claude-code) connecté sur le Mac (`claude`, puis `/login`) | Le travail des agents, sur ton abonnement | Ton abonnement |
| **Un Mac** allumé quand les agents travaillent, avec Node 24, git, gh, Claude Code | Le runner s'y installe comme agent launchd | — |
| Telegram (facultatif) | Notifications, questions, commandes `/etat`, `/pause` | Gratuit |
| Un serveur Linux (facultatif) | Le veilleur de services : surveiller et mettre en pause ce qui y tourne | — |

> Les agents tournent avec `--dangerously-skip-permissions` sous ton compte macOS : ils ont accès à ce que ton compte
> a (gh, wrangler, Xcode…). Donne-leur des repos et des droits que tu es prêt à leur confier.

---

## Installer ton instance

Toute la configuration propre à ton installation (domaine, compte Cloudflare, base D1, Access) vit **hors du repo**,
dans `~/.essaim/instance.json` ; `web/wrangler.jsonc` en est généré (`npm run configure`) et n'est jamais committé.
Ton fork reste donc identique au repo public, et se met à jour sans conflit.

### 1. Forker et cloner

Sur la page GitHub du repo public d'Essaim, **Fork** (ou `gh repo fork <repo-public> --clone`), puis :

```bash
gh repo clone <ton-compte>/essaim ~/essaim     # le runner tournera depuis ce dossier : garde-le
cd ~/essaim/web && npm install
```

Un fork d'un repo public est public. Il ne contient rien de ton installation ; si tu le veux quand même privé,
importe le repo au lieu de le forker (github.com/new/import), et ajoute le repo public comme remote `upstream`.

### 2. Cloudflare : connexion et base D1

```bash
cd ~/essaim/web
npx wrangler login                       # ouvre le navigateur
npx wrangler whoami                      # note l'Account ID si tu as plusieurs comptes
npx wrangler d1 create essaim --no-update-config   # note le database_id affiché
npm run configure -- --set domain=essaim.ton-domaine.fr --set databaseId=<database_id> [--set accountId=<account_id>]
```

L'identifiant de la base se retrouve avec `npx wrangler d1 list`. `web/wrangler.jsonc` est régénéré à chaque
commande : ne le modifie pas à la main.

### 3. Cloudflare Access (Zero Trust)

Dans le tableau de bord Cloudflare, **Zero Trust** (la première fois : choisis un nom d'équipe, offre Free).

1. **Nom d'équipe** : Settings → Team name and domain : `<équipe>.cloudflareaccess.com`.
2. **Méthode de connexion** : « One-time PIN » (code par e-mail) est active par défaut, rien à faire.
3. **Access → Applications → Add an application → Self-hosted** :
   - nom `Essaim`, domaine `essaim.ton-domaine.fr` (sans chemin), durée de session au choix (1 mois, par exemple) ;
   - politique **Allow** : Include → Emails → ton adresse ;
   - une fois créée, copie son **Application Audience (AUD) Tag** (onglet Overview / Basic information).
4. Deux autres applications **Self-hosted**, pour les chemins qui ont leur propre secret :
   - domaine `essaim.ton-domaine.fr`, chemin `api/runner`, politique **Bypass**, Include → Everyone ;
   - domaine `essaim.ton-domaine.fr`, chemin `api/telegram`, politique **Bypass**, Include → Everyone.

```bash
npm run configure -- --set accessTeamDomain=<équipe> --set accessAud=<AUD>
npm run configure -- --show              # « Instance complète. »
```

### 4. Base de données et mise en ligne

```bash
npm run db:migrate:remote
npm run deploy                           # crée le Worker et le domaine essaim.ton-domaine.fr
```

Ouvre `https://essaim.ton-domaine.fr` : Access te demande ton adresse, t'envoie un code, puis Essaim s'affiche
(vide). Le domaine personnalisé peut demander une minute la première fois (certificat).

### 5. Le runner sur ton Mac

```bash
cd ~/essaim/runner && ./install-mac.sh
grep '^RUNNER_TOKEN=' ~/.essaim/runner.env | cut -d= -f2 | (cd ../web && npx wrangler secret put RUNNER_TOKEN)
```

`install-mac.sh` crée `~/.essaim/runner.env` (0600, `CONTROL_URL` pris dans ton instance, `RUNNER_TOKEN` tiré au
hasard), installe l'agent launchd `com.essaim.runner` (démarrage à l'ouverture de session, redémarrage automatique,
`caffeinate -is` contre la veille sur secteur) et le lance. La seconde commande donne le même jeton au Worker.
Dans la minute, ton Mac apparaît dans Essaim (barre latérale, « Machines »). Journal : `tail -f ~/.essaim/logs/runner.log`.

Vérifie aussi que `gh auth status` et `claude` (connecté à ton abonnement) marchent dans un terminal : le runner
utilise les mêmes.

### 6. Telegram (facultatif)

1. Crée un bot avec [@BotFather](https://t.me/BotFather) (`/newbot`), garde son jeton.
2. Crée un groupe Telegram, active les **Sujets** (réglages du groupe), ajoute le bot en **administrateur** avec le
   droit « Gérer les sujets ».
3. Les secrets :
   ```bash
   cd ~/essaim/web
   npx wrangler secret put TELEGRAM_BOT_TOKEN          # colle le jeton du bot
   openssl rand -hex 32 | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```
4. Dans Essaim, **Réglages → Telegram** : « Brancher le webhook », envoie `/etat` dans le groupe, recharge,
   « Utiliser ce groupe ». Un sujet par agent : crée-le dans le groupe, copie son lien (appui long → Copier le lien)
   et colle-le dans « Sujet Telegram » de l'agent (sans lien, le bot le crée lui-même).

Commandes : `/etat`, `/pause [agent ou service]`, `/reprise […]` (dans le sujet d'un agent, le nom est facultatif),
`/travail`, `/fin`.

### 7. Ton premier agent

**Nouvel agent** : un nom, un repo GitHub (`ton-compte/mon-app`, ou « Nouveau projet » pour que l'agent le crée),
ses droits (merger, déployer, publier). Écris une tâche, mets-la en file : le runner la prend dans les 20 s.

### 8. L'app macOS (facultatif)

Essaim dans sa propre fenêtre, avec son icône et un badge dans le Dock. Elle n'est pas distribuée : on la fabrique
sur le Mac (outils de ligne de commande Xcode requis : `xcode-select --install`).

```bash
cd ~/essaim && desktop/build.sh install   # compile, installe dans /Applications (ou ~/Applications) et lance
```

L'adresse de ton instance y est inscrite au build (domaine de `~/.essaim/instance.json`, ou
`ESSAIM_URL=https://… desktop/build.sh install`) ; sans l'un ni l'autre, l'app la demande au premier lancement.
Menu Essaim → « Changer d'adresse… » pour en changer. Au premier lancement, la page Access s'ouvre dans la fenêtre
(code par e-mail) ; la session est gardée d'un lancement à l'autre.

- **Badge du Dock** : questions des agents + services en panne, relu chaque minute sur `/badge` (même fenêtre
  fermée ; ⌘W ferme la fenêtre, l'app reste dans le Dock).
- **Liens** : GitHub et tout ce qui sort d'Essaim s'ouvre dans le navigateur ; ⌘⇧O ouvre la page courante.
- **Raccourcis** : ⌘1 l'équipe, ⌘2 services, ⌘N nouvel agent, ⌘, réglages, ⌘R recharger, ⌘[ / ⌘] précédent /
  suivant, ⌘+ / ⌘- zoom.
- **Dev local** : `defaults write com.essaim.desktop url http://localhost:5173` (`defaults delete com.essaim.desktop url`
  pour revenir). `ESSAIM_SNAPSHOT=/tmp/x.png` fait écrire une capture de la page après chaque chargement.

### 9. Un serveur Linux et ses services (facultatif)

Page « Services » : ce qui tourne en continu sur un serveur, rangé par groupe, avec un bouton pause / relance
(un service ou tout un groupe), aussi sur Telegram (`/pause <service ou groupe>`), et une alerte quand un service
tombe ou repart. Le **veilleur** (`runner/src/services-main.mjs`, Node 24, root) relève toutes les 30 s l'état des
services décrits dans `/etc/essaim-services.json`, l'envoie à `POST /api/runner/services` et applique les pauses.

Trois sortes de services (modèle : [`runner/services.example.json`](runner/services.example.json)) :

| Type | Ce qu'il surveille | Pause |
|---|---|---|
| `systemd` | des unités (`units`), et un `healthUrl` facultatif | `systemctl disable --now` (tient au redémarrage) ; `"pausable": false` pour surveiller seulement |
| `http` | une adresse (`url`) | aucune |
| `hub-agent` | un agent d'un processus qui en fait tourner plusieurs (`unit`) et expose `GET statusUrl` → `{ jobs: [{ name, enabled, running, lastRun }] }` | la variable `flag` forcée à `false` par un drop-in systemd, puis redémarrage de l'unité quand aucun de ses jobs ne tourne |

Installation, en root sur le serveur, avec le dossier `runner/` copié dessus :

```bash
./install-services.sh mes-services.json   # 1er passage : crée /etc/essaim-services.env
# renseigne CONTROL_URL et RUNNER_TOKEN (le même que le Worker) dans /etc/essaim-services.env, puis :
./install-services.sh
journalctl -u essaim-services -f
```

Le serveur apparaît dans « Machines » (alerte s'il se tait 10 min). `install-services.sh uninstall` retire le
veilleur (les pauses en cours restent).

---

## Mettre à jour

- **Ton fork** : « Sync fork » sur GitHub (ou `gh repo sync <ton-compte>/essaim`).
- **Le runner** se met à jour seul : toutes les 30 min, il fait un `git fetch` de son dossier et avance en
  fast-forward s'il est propre (sur la branche par défaut, sans commit local). Si `runner/` a changé, il finit ses
  tâches en cours (30 min au plus) puis redémarre. `AUTO_UPDATE=0` dans `runner.env` pour le couper.
- **Le Worker** :
  ```bash
  cd ~/essaim && git pull && cd web && npm install && npm run db:migrate:remote && npm run deploy
  ```
  Astuce : fais-en une « action en un clic » sur un agent qui travaille sur ton fork.
- **L'app macOS** : `desktop/build.sh install`.

---

## Comment ça marche

### Cycle d'une tâche

Essaim fait foi : tu écris la tâche (brouillon), tu la mets en file et tu ordonnes la file sur la page de l'agent.
Le runner tient l'issue GitHub à jour comme sauvegarde : il la crée quand la tâche entre en file, y recopie tes
modifications, la ferme si tu abandonnes la tâche. Les questions se répondent dans Essaim (ou en commentaire de
l'issue). Tu peux mettre une tâche en pause, la reprendre, l'abandonner, puis la reprendre plus tard.

| Étiquette de l'issue | Sens |
|---|---|
| `agent:ready` | la tâche est dans la file de l'agent |
| `agent:wip` | un agent travaille dessus, dans `~/.essaim/worktrees/<repo>/<n°>` sur la branche `agent/<n°>-<titre>` |
| `agent:needs-human` | l'agent a posé une question et est passé à la tâche suivante ; ta réponse la remet en tête de file et la même session Claude reprend |
| `agent:done` | traité ; le résumé est en commentaire |

- **Limite de l'abonnement** : Claude Code annonce l'état du quota (fenêtres 5 h et 7 jours). Quand il est refusé,
  le runner n'en lance plus jusqu'à la réinitialisation, puis reprend les sessions interrompues (`claude --resume`),
  dans l'ordre de priorité des agents.
- **Pause / « Je travaille »** : le run en cours est arrêté proprement et repris plus tard au même endroit.
- **Pas de limite de temps par défaut** (optionnelle par agent). L'agent annonce ses jalons (`JALON: …`) et tu reçois
  une alerte s'il n'en franchit aucun pendant 3 h (réglable).
- **Erreur** : nouvel essai ; au 3e échec, question. Runner coupé : les runs reprennent au redémarrage ; le cron du
  Worker te prévient si une machine ne répond plus depuis 10 min.
- **Découpage** : une tâche trop grosse revient découpée en étapes ; Essaim en fait des sous-tâches, le runner des
  sous-issues GitHub.

Règles données à chaque agent : [`runner/src/prompt.mjs`](runner/src/prompt.mjs) (jamais de push sur la branche par
défaut ni de force push, aucune attribution à une IA, PR « Closes #n », réponse finale structurée).

### Conversation en direct

Sur la page d'un agent, le fil de sa conversation façon Claude Code : son texte en direct, ses actions repliées, tes
messages. Un message écrit pendant qu'il travaille est glissé dans sa session ; « Nouvelle conversation » ouvre une
discussion libre dans son repo, sur une branche à part. Transport : Durable Object `Hub`, WebSocket sortante du runner
sur `/api/runner/ws`, WebSocket de la page sur `/ws/agents/:id` ; l'historique est dans D1.

### Connaissance d'un agent

- **Brief** (écrit par toi) et **mémoire** (tenue par l'agent, 200 lignes au plus) : page « Mémoire » de l'agent. Le
  runner les écrit dans `~/.essaim/agents/<id>/` (avec `JOURNAL.md`, un résumé par tâche) et les injecte dans le
  prompt système, identique d'une tâche à l'autre (le cache de prompt le réutilise).
- **Une session par tâche** ; les suites (réponse, quota, reprise) reprennent la même session.
- **Sous-agents** : `explorateur` (recherche) et `testeur` (tests et build), pour garder le contexte léger.
- **Consommation** : tokens de chaque session, par tâche et par agent.

### Actions en un clic

Boutons sur la page d'un agent (« Installer sur mon iPhone », « Générer l'APK », « Déployer »…), gérés sur
`/agents/:id/actions`. Le plus simple : le demander à l'agent dans une discussion ; il met la commande au point et
l'écrit dans `~/.essaim/agents/<id>/ACTIONS.json`, que le runner renvoie à Essaim.
- **Commande** : lancée dans une copie du repo remise sur la dernière version de la branche par défaut, avec le shell
  de connexion de la machine ; sortie en direct, durée max (60 min par défaut), bouton « Arrêter », notification à
  la fin. Une action à la fois par repo ; elles ne prennent pas de place aux agents.
- **Consigne** : envoyée à l'agent dans une nouvelle discussion, pour ce qui demande du jugement.

### Machines et places

Chaque machine a un nombre de places (runs simultanés, `CAPACITY`, 2 par défaut), réglable ponctuellement dans
Essaim (page de la machine, de 1 à 16, avec une durée), qui montre aussi ses ressources (processeur, mémoire, disque).

---

## Référence

### Fichiers de configuration

| Fichier | Contenu |
|---|---|
| `~/.essaim/instance.json` | Ton instance : `domain`, `databaseId`, `accessTeamDomain`, `accessAud` (obligatoires), `accountId`, `workerName`, `databaseName`, `telegramChatId`. Autre emplacement : variable `ESSAIM_INSTANCE`. Modifier : `npm run configure -- --set clé=valeur` |
| `web/wrangler.jsonc` | Généré depuis l'instance par `npm run configure` (appelé aussi par `dev`, `build`, `deploy`, `typecheck`…). Ignoré par git |
| Secrets du Worker | `RUNNER_TOKEN` (obligatoire), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (`npx wrangler secret put …`) |
| `~/.essaim/runner.env` | Le runner (ci-dessous) |
| `/etc/essaim-services.env`, `/etc/essaim-services.json` | Le veilleur d'un serveur |

### Variables du runner (`~/.essaim/runner.env`)

| Variable | |
|---|---|
| `CONTROL_URL` | URL de ton Essaim |
| `RUNNER_TOKEN` | secret partagé avec le Worker (32 caractères au moins) |
| `MACHINE` | `mac` (défaut) ou `nuc` (le serveur) : le runner ne prend que les agents de sa machine |
| `CAPACITY` | runs simultanés par défaut (2) |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | modèle et effort par défaut (réglables par agent) |
| `CF_ACCESS_CLIENT_ID/SECRET` | jeton de service Access, si `/api/runner/*` n'est pas en Bypass |
| `ESSAIM_HOME`, `CLAUDE_BIN`, `POLL_MS`, `REPLY_CHECK_MS` | dossier d'état (`~/.essaim`), binaire, cadences (20 s, 2 min) |
| `AUTO_UPDATE`, `UPDATE_CHECK_MS` | mise à jour automatique du runner (`1`, toutes les 30 min ; `0` pour la couper) |

Le runner retire `ANTHROPIC_API_KEY` de son environnement pour rester sur l'abonnement. `./install-mac.sh uninstall`
l'enlève (l'état reste dans `~/.essaim`).

### Développer

```bash
cd web && cp .dev.vars.example .dev.vars        # ENVIRONMENT=development : pas d'Access en local
npm run db:migrate:local && npm run dev          # http://localhost:5173
npm test && npm run typecheck && npm run build
cd ../runner && npm test
```

Sans instance, `npm run configure` génère une configuration neutre, suffisante pour le dev local, les types et les
tests. Pour proposer une modification : une PR sur le repo public.

### Dépannage

| Symptôme | Piste |
|---|---|
| `Cloudflare Access n'est pas configuré.` (503) | `accessTeamDomain` ou `accessAud` manque : `npm run configure -- --show`, puis `npm run deploy` |
| `Accès refusé.` (403) | l'AUD ne correspond pas à l'application Access du domaine, ou le domaine n'est pas couvert par Access |
| Le Mac n'apparaît pas dans « Machines » | `tail ~/.essaim/logs/runner.log` : `CONTROL_URL`, `RUNNER_TOKEN` différent du secret du Worker, chemin `/api/runner` pas en Bypass |
| `npm run deploy` : « Instance incomplète » | renseigne les clés manquantes avec `npm run configure -- --set …` |
| Une tâche ne démarre pas | `gh auth status`, le repo existe, `claude` connecté ; l'erreur est sur la page de l'agent et dans le journal |
| Repo en Git LFS | installer git-lfs sur le Mac (`brew install git-lfs && git lfs install`) |

## Licence

[MIT](LICENSE).
