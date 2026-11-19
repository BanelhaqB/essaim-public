# Installer Essaim : guide pour une IA

> **Pour l'humain** : ouvre un agent de code sur ton Mac (Claude Code, par exemple, lancé dans un terminal) et
> donne-lui ce fichier : « Lis https://github.com/BanelhaqB/essaim-public/blob/main/INSTALLATION-IA.md et installe
> Essaim pour moi ». Il fera tout ce qui se fait en ligne de commande et te guidera pour le
> reste (connexions, tableau de bord Cloudflare, Telegram).

---

## Ton rôle

Tu installes Essaim pour la personne avec qui tu parles (« l'humain »), de A à Z, sur son Mac et son compte
Cloudflare. Essaim : un Worker Cloudflare (`web/`, interface + API, base D1, protégé par Cloudflare Access) et un
runner sur le Mac (`runner/`) qui fait travailler Claude Code sur des tâches GitHub. Le `README.md` du repo est la
référence ; ce guide en est la version pas à pas.

Règles :

1. **Exécute toi-même** tout ce qui se fait en terminal. Demande à l'humain seulement ce que lui seul peut faire :
   se connecter (navigateur), cliquer dans le tableau de bord Cloudflare ou Telegram, choisir un domaine, payer.
   Pour ces étapes, donne-lui des instructions courtes et numérotées, puis attends sa réponse.
2. **Vérifie chaque étape** avec la commande de contrôle indiquée avant de passer à la suivante. En cas d'échec,
   consulte « Dépannage » en bas, corrige, revérifie.
3. **Secrets** (`RUNNER_TOKEN`, jetons Telegram, jeton d'API) : fais-les passer par des tubes (`… | npx wrangler secret
   put …`), ne les affiche jamais en entier, ne les écris dans aucun fichier du repo, ne les committe jamais.
4. **Ne modifie pas le code** d'Essaim pour l'installer. `web/wrangler.jsonc` est généré : ne l'édite pas, utilise
   `npm run configure -- --set clé=valeur`. Toute la configuration de l'instance vit dans `~/.essaim/instance.json`.
5. **Idempotence** : si une étape est déjà faite (base D1 existante, runner installé…), constate-le et passe à la
   suite sans recréer.
6. Parle en français, simplement. Récapitule à la fin ce qui est installé et ce qui reste éventuellement à faire.

---

## Étape 0 : questions de départ

Pose ces questions en une fois :

1. L'adresse du repo public d'Essaim → `UPSTREAM` (par défaut `BanelhaqB/essaim-public`).
2. Le **domaine** Cloudflare à utiliser et le sous-domaine voulu (défaut : `essaim.<domaine>`) → `DOMAIN`.
   Il doit être une zone active de son compte Cloudflare. S'il n'a pas de domaine : il doit en acheter un
   (Cloudflare Registrar : Domain Registration → Register) avant de continuer.
3. Son **adresse e-mail** pour se connecter à Essaim (Cloudflare Access) → `EMAIL`.
4. Veut-il **Telegram** (notifications, questions des agents) ? **L'app macOS** ? Un **serveur Linux** à surveiller ?
5. A-t-il un abonnement **Claude Pro ou Max** ? (obligatoire : les agents tournent sur cet abonnement).

## Étape 1 : prérequis du Mac

Contrôle et installe ce qui manque (Homebrew : https://brew.sh si absent) :

```bash
sw_vers -productVersion                 # macOS
node -v                                 # v24 ou plus (sinon : brew install node@24, ou nvm install 24)
git --version
gh --version || brew install gh
claude --version || npm install -g @anthropic-ai/claude-code
xcode-select -p || xcode-select --install   # seulement pour l'app macOS
```

👤 Connexions (l'humain, dans un terminal ou le navigateur que la commande ouvre) :

- `gh auth login` (GitHub.com, HTTPS, navigateur). Contrôle : `gh auth status`.
- `claude` puis `/login` avec son compte Claude (abonnement, pas une clé d'API), puis `/exit`.
  Contrôle : `claude -p "réponds ok"` affiche une réponse. `ANTHROPIC_API_KEY` ne doit pas être nécessaire.

## Étape 2 : fork et clone

```bash
gh repo fork "$UPSTREAM" --fork-name essaim --clone=false
gh repo clone "$(gh api user --jq .login)/essaim" ~/essaim
cd ~/essaim/web && npm install
```

Contrôle : `ls ~/essaim/web/node_modules/.bin/wrangler` et `git -C ~/essaim remote -v` (origin = son fork).
Le runner tournera depuis `~/essaim` : ne déplace pas ce dossier ensuite.

## Étape 3 : Cloudflare, connexion et base D1

```bash
cd ~/essaim/web
npx wrangler login        # 👤 l'humain autorise dans le navigateur
npx wrangler whoami       # liste ses comptes
```

S'il a plusieurs comptes, demande lequel utiliser et garde son Account ID → `ACCOUNT_ID`.

```bash
npx wrangler d1 list --json        # une base « essaim » existe déjà ? reprends son uuid
npx wrangler d1 create essaim --no-update-config   # sinon : crée-la et garde le database_id affiché
npm run configure -- --set domain=$DOMAIN --set databaseId=<uuid> [--set accountId=$ACCOUNT_ID]
```

Contrôle : `npm run configure -- --show` (il ne doit plus manquer que `accessTeamDomain` et `accessAud`).

## Étape 4 : Cloudflare Access

Access protège l'interface : sans lui, le Worker refuse de servir quoi que ce soit (503). Il faut trois applications
sur `$DOMAIN` : l'interface (réservée à `$EMAIL`), et deux chemins en Bypass qui ont leur propre secret
(`/api/runner` pour le runner, `/api/telegram` pour le webhook Telegram).

### Option A (par défaut) : l'humain clique, tu guides

👤 Donne-lui ces instructions :

1. https://one.dash.cloudflare.com → choisir le compte. La première fois : choisir un **nom d'équipe** et l'offre
   **Free** (Cloudflare peut demander un moyen de paiement, même pour l'offre gratuite).
2. Settings → **Team name and domain** : te donner le nom d'équipe (`<équipe>.cloudflareaccess.com`).
3. Access → Applications → **Add an application → Self-hosted** :
   - Application name `Essaim` ; Session duration `1 month` ; domaine : sous-domaine et domaine de `$DOMAIN`, chemin
     vide ;
   - Policy : nom `Moi`, Action **Allow**, Include → **Emails** → `$EMAIL` ;
   - enregistrer, puis ouvrir l'application et te donner son **Application Audience (AUD) Tag**.
4. Encore **Add an application → Self-hosted**, deux fois :
   - `Essaim runner` : même domaine, chemin `api/runner`, policy Action **Bypass**, Include → **Everyone** ;
   - `Essaim telegram` : même domaine, chemin `api/telegram`, policy Action **Bypass**, Include → **Everyone**.

La méthode de connexion « One-time PIN » (code par e-mail) est active par défaut : rien à faire.

### Option B : par l'API, si l'humain préfère te donner un jeton

👤 Il crée un jeton : https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token, permissions
**Account → Access: Apps and Policies → Edit** et **Account → Access: Organizations, Identity Providers, and Groups →
Read**, sur son compte. Il doit d'abord avoir activé Zero Trust (étape A.1). Garde le jeton dans une variable du shell,
jamais dans un fichier :

```bash
read -rs CF_API_TOKEN && export CF_API_TOKEN       # l'humain colle le jeton
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access"
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")
curl -s "${H[@]}" "$API/organizations" | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.auth_domain'
app() { curl -s "${H[@]}" -X POST "$API/apps" -d "$1" | node -pe 'const r = JSON.parse(require("fs").readFileSync(0)); r.success ? r.result.aud : JSON.stringify(r.errors)'; }
app "{\"name\":\"Essaim\",\"type\":\"self_hosted\",\"domain\":\"$DOMAIN\",\"session_duration\":\"720h\",\"policies\":[{\"name\":\"Moi\",\"decision\":\"allow\",\"include\":[{\"email\":{\"email\":\"$EMAIL\"}}]}]}"
app "{\"name\":\"Essaim runner\",\"type\":\"self_hosted\",\"domain\":\"$DOMAIN/api/runner\",\"policies\":[{\"name\":\"Runner\",\"decision\":\"bypass\",\"include\":[{\"everyone\":{}}]}]}"
app "{\"name\":\"Essaim telegram\",\"type\":\"self_hosted\",\"domain\":\"$DOMAIN/api/telegram\",\"policies\":[{\"name\":\"Telegram\",\"decision\":\"bypass\",\"include\":[{\"everyone\":{}}]}]}"
```

Le premier `app` affiche l'AUD de l'interface. Si l'API refuse (forme des politiques, droits), repasse à l'option A.
À la fin, propose à l'humain de supprimer le jeton.

### Puis

```bash
npm run configure -- --set accessTeamDomain=<équipe> --set accessAud=<AUD>
npm run configure -- --show        # « Instance complète. »
```

## Étape 5 : base et mise en ligne

```bash
cd ~/essaim/web
npm run db:migrate:remote          # répond oui si wrangler demande confirmation
npm run deploy
```

Contrôles :

- `curl -sI https://$DOMAIN/ | head -5` → une redirection (302) vers `…cloudflareaccess.com` (Access protège bien).
  Une 503 « Cloudflare Access n'est pas configuré » : l'instance n'a pas l'AUD ; 522/erreur DNS : attends une minute
  (le domaine personnalisé et son certificat se créent au premier déploiement).
- `curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/api/runner/sync` → `401` (le Worker répond, le
  Bypass marche). Une redirection vers Access : l'application Bypass `api/runner` manque.
- 👤 L'humain ouvre `https://$DOMAIN`, reçoit le code par e-mail et voit Essaim (vide).

## Étape 6 : le runner

```bash
cd ~/essaim/runner && ./install-mac.sh
grep '^RUNNER_TOKEN=' ~/.essaim/runner.env | cut -d= -f2 | (cd ~/essaim/web && npx wrangler secret put RUNNER_TOKEN)
```

Contrôles :

- `grep CONTROL_URL ~/.essaim/runner.env` → `https://$DOMAIN`.
- `launchctl print gui/$(id -u)/com.essaim.runner | grep state` → `running`.
- `tail -20 ~/.essaim/logs/runner.log` : pas d'erreur 401/403 répétée après une minute (le secret met quelques
  secondes à se propager).
- 👤 Dans Essaim, la machine « Mac » apparaît (barre latérale ou Réglages → Machines).

## Étape 7 : Telegram (si voulu)

👤 L'humain :

1. Dans Telegram, @BotFather → `/newbot` → garde le jeton.
2. Crée un groupe, active les **Sujets** (Topics) dans ses réglages, ajoute le bot en **administrateur** avec le
   droit « Gérer les sujets ».

Toi :

```bash
cd ~/essaim/web
read -rs BOT && printf %s "$BOT" | npx wrangler secret put TELEGRAM_BOT_TOKEN && unset BOT   # l'humain colle le jeton
openssl rand -hex 32 | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

👤 Puis dans Essaim, **Réglages → Telegram** : « Brancher le webhook » ; envoyer `/etat` dans le groupe ; recharger ;
« Utiliser ce groupe » ; « Envoyer un message de test ». Contrôle : le message arrive dans le groupe.

## Étape 8 : l'app macOS (si voulue)

```bash
cd ~/essaim && desktop/build.sh install
```

L'adresse est prise dans `~/.essaim/instance.json`. Contrôle : la sortie se termine par « ✓ installée dans … » et
l'app s'ouvre sur la page de connexion Access. 👤 L'humain s'y connecte une fois (code par e-mail).

## Étape 9 : un serveur Linux (si voulu)

Le veilleur surveille des services systemd ou HTTP d'un serveur Linux et permet de les mettre en pause depuis Essaim.
Demande quels services surveiller, écris leur description en suivant `runner/services.example.json` et la section
« Un serveur Linux et ses services » du README, puis, avec un accès SSH root au serveur (Node 24 installé) :

```bash
cd ~/essaim && tar czf /tmp/essaim-runner.tgz runner && scp /tmp/essaim-runner.tgz <serveur>:/tmp/
ssh <serveur> 'rm -rf /tmp/er && mkdir /tmp/er && tar xzf /tmp/essaim-runner.tgz -C /tmp/er && /tmp/er/runner/install-services.sh /tmp/er/runner/services.json'
```

(`services.json` : le fichier que tu as écrit, copié dans `runner/` avant le `tar`, puis retiré.) Le premier passage
crée `/etc/essaim-services.env` : renseignes-y `CONTROL_URL=https://$DOMAIN` et `RUNNER_TOKEN` (le même que
`~/.essaim/runner.env`), puis relance `install-services.sh`. Contrôle : `ssh <serveur> journalctl -u essaim-services -n 20`
et la page « Services » d'Essaim.

## Étape 10 : premier agent et fin

👤 Propose à l'humain de créer son premier agent : **Nouvel agent** → un nom, un repo GitHub (`compte/repo`, ou
« Nouveau projet »), ses droits ; puis une petite tâche mise en file (« Ajoute un README »). Contrôle : dans la
minute, l'agent passe « Au travail » et une issue `agent:wip` apparaît sur le repo.

Récapitule : l'adresse, ce qui est installé, où sont les fichiers (`~/.essaim/instance.json`, `~/.essaim/runner.env`,
journal `~/.essaim/logs/runner.log`), et comment mettre à jour (section « Mettre à jour » du README).

---

## Dépannage

| Symptôme | Cause probable → correction |
|---|---|
| `npm run deploy` : « Instance incomplète » | clés manquantes → `npm run configure -- --show`, puis `--set` |
| Déploiement : « zone not found » / domaine refusé | `$DOMAIN` n'est pas dans une zone active du compte choisi → vérifier le domaine, ou `accountId` |
| 503 « Cloudflare Access n'est pas configuré » | `accessTeamDomain`/`accessAud` absents du dernier déploiement → configure puis `npm run deploy` |
| 403 « Accès refusé » après connexion | AUD faux (celui d'une autre application) ou `accessTeamDomain` faux → corriger, redéployer |
| Runner : 401 dans le journal | `RUNNER_TOKEN` du Mac ≠ secret du Worker → refaire la commande `secret put` de l'étape 6 |
| Runner : réponse HTML / redirection vers Access | application Bypass `api/runner` absente ou mal écrite |
| Runner : `CONTROL_URL et RUNNER_TOKEN … sont requis` | `~/.essaim/runner.env` incomplet → le corriger, `./install-mac.sh` |
| Une tâche ne démarre pas | `gh auth status`, accès au repo, `claude` connecté ; l'erreur s'affiche sur la page de l'agent |
| `wrangler` demande de choisir un compte | `npm run configure -- --set accountId=<id>` |
| Telegram : rien n'arrive | Réglages → Telegram : chaque étape doit être cochée ; le bot doit être administrateur du groupe |
