FROM node:20-slim
WORKDIR /app

# Install build tools required for sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Pre-build GTFS database into the image
RUN npx tsx scripts/build-gtfs.ts

EXPOSE 3000
CMD ["npm", "start"]
