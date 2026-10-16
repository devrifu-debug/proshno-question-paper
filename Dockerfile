# Proshno: the app plus its small sign-in server (server.mjs, no dependencies).
FROM node:22-alpine
WORKDIR /app
COPY server.mjs index.html admin.html sw.js manifest.webmanifest ./
COPY icons ./icons
COPY checker ./checker
# users and the signing key live here: mount a volume on /data so they survive redeploys
ENV PORT=80 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1
CMD ["node", "server.mjs"]
