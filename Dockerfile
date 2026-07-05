FROM oven/bun:1-slim
WORKDIR /usr/src/auklet

COPY package.json bun.lock* ./
RUN bun install --production

COPY src src
COPY index.js cli.js ./

EXPOSE 8899
CMD ["bun", "index.js"]
