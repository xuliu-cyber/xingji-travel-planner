FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g @fly-ai/flyai-cli@1.0.16
COPY public ./public
COPY src ./src
COPY scripts/local-server.mjs ./scripts/local-server.mjs

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
