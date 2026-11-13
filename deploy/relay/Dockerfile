FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.cjs ./server.cjs
USER node
CMD ["node", "--max-old-space-size=64", "server.cjs"]
