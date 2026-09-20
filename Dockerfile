FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/school-bus .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/school-bus /app/school-bus
COPY data /app/data
ENV PORT=8080
ENV DATA_FILE=/app/data/store.json
EXPOSE 8080
ENTRYPOINT ["/app/school-bus"]
