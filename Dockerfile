# Build with the dev toolchain, run with neither it nor the sources: tsc emits the random-battle datasets
# into dist alongside the code, so the runtime image needs dist and the production dependencies only.
# The lookahead engine is Rust; built here for the image's own platform and libc, so nothing built on the Mac ships.
FROM rust:1-alpine AS engine
RUN apk add --no-cache musl-dev
WORKDIR /engine
COPY vendor/poke-engine ./
RUN cargo build --release --features gen9,terastallization --bin poke-engine

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=engine /engine/target/release/poke-engine ./vendor/poke-engine/target/release/poke-engine
# Battle logs are the record of every decision, so they are written to a mounted directory, not the layer.
RUN mkdir -p logs && chown -R node:node /app
USER node
# The live view must bind every interface to be reachable from a published port; compose publishes it on the
# host's loopback only, because the view has no authentication of its own.
ENV LIVE_VIEW_HOST=0.0.0.0
EXPOSE 8733
CMD ["node", "dist/src/index.js"]
