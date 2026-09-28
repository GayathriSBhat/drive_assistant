# KenDrive web app (Next.js, standalone output).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Where /api/* is proxied to. Rewrites are resolved at build time, so this is a build arg.
ARG KENDRIVE_API_ORIGIN=http://api:8000
# Browser key for the Maps JavaScript API (restrict it to your domains). Optional: without it the map card stays hidden.
ARG NEXT_PUBLIC_GOOGLE_MAPS_KEY=""
ENV KENDRIVE_API_ORIGIN=$KENDRIVE_API_ORIGIN \
    NEXT_PUBLIC_GOOGLE_MAPS_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
