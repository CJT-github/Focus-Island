FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.cjs channel-store.cjs ./
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "--max-old-space-size=64", "server.cjs"]
