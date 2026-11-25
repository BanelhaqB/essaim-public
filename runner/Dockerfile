# Runner d'Essaim en conteneur (NAS, serveur Linux). Contexte de build : le dossier runner/.
#   docker compose -f docker-compose.yml build
# Claude Code refuse --dangerously-skip-permissions en root : le conteneur tourne avec l'utilisateur « node ».
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl ripgrep jq procps gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV HOME=/home/node \
    ESSAIM_HOME=/home/node/.essaim \
    MACHINE=nuc \
    AUTO_UPDATE=0 \
    LANG=C.UTF-8

USER node
RUN mkdir -p /home/node/.essaim /home/node/.claude /home/node/.config/gh
WORKDIR /home/node/.essaim

CMD ["node", "/app/src/runner.mjs"]
