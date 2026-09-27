FROM node:20-slim

# Install Bob Shell globally (same package as local install)
RUN npm install -g bobshell@2.0.5

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "web/server.js"]
