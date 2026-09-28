FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
