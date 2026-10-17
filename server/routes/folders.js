import { randomUUID } from "node:crypto";

// Folder routes under /api: create, rename, delete. Deleting a folder leaves
// its conversations in place; they become unfiled.
export function mountFolderRoutes(ctx) {
  const { app, db, publish, folderFields } = ctx;

  app.post("/api/folders", (req, res) => {
    if (db.folders.length >= 50)
      throw new Error("You can have up to 50 folders.");
    const folder = {
      id: randomUUID(),
      ...folderFields(req.body),
      createdAt: new Date().toISOString(),
    };
    db.folders.push(folder);
    publish();
    res.json(folder);
  });

  app.patch("/api/folders/:id", (req, res) => {
    const folder = db.folders.find((f) => f.id === req.params.id);
    if (!folder) throw new Error("Folder not found.");
    Object.assign(folder, folderFields(req.body, folder));
    publish();
    res.json(folder);
  });

  app.delete("/api/folders/:id", (req, res) => {
    const folder = db.folders.find((f) => f.id === req.params.id);
    if (!folder) throw new Error("Folder not found.");
    // Removing a folder keeps its conversations; they become unfiled.
    for (const r of db.rooms) if (r.folderId === folder.id) r.folderId = null;
    db.folders = db.folders.filter((f) => f !== folder);
    publish();
    res.json({ ok: true });
  });
}
