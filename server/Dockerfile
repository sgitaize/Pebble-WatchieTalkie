# WatchieTalkie2-Server – klein, ohne Abhängigkeiten
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY pages ./pages
COPY scripts ./scripts
RUN mkdir -p data tmp logs && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/v1/info >/dev/null || exit 1
CMD ["node", "server.js"]
