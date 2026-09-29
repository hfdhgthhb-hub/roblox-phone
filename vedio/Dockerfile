FROM node:20-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 python3-pip git \
 && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" bgutil-ytdlp-pot-provider \
 && rm -rf /var/lib/apt/lists/*
# PO-token provider (optional helper; build never fails the deploy)
RUN (git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/pot \
 && cd /opt/pot/server && yarn install --frozen-lockfile && npx tsc) || echo "pot provider build skipped"
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
