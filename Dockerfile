FROM node:22.19-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Base SQLite et fichiers déposés : à monter sur un volume pour les conserver
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/sante || exit 1
CMD ["npm", "start"]
