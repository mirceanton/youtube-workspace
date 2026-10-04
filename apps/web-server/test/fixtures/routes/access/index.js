export default async function accessRoutes(app) {
  app.get("/api/protected", { preHandler: app.requireLevel("ideas", "read") }, (request) => ({
    username: request.auth.username,
  }));
  app.post("/api/protected", { preHandler: app.requireLevel("ideas", "write") }, () => ({
    saved: true,
  }));
  app.post("/api/actor", { preHandler: app.requireLevel("ideas", "write") }, (request) =>
    app.db.withActor(request, (tx) => Promise.resolve(tx.actor)),
  );
}
