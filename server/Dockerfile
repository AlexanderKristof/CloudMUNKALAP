FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/munkalap.db
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
