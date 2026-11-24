import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const metadata = {
  name: z.string().trim().min(1).max(120),
  tags: z.string().trim().max(160),
  note: z.string().trim().max(400),
};
const upload = z.object({
  ...metadata,
  image: z.string().max(2_000_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export function openSharedWardrobe(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_wardrobe (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, note TEXT NOT NULL,
    photo BLOB NOT NULL, created INTEGER NOT NULL
  )`);
  const columns = "id,name,tags,note";
  return {
    list: () => db.prepare(`SELECT ${columns} FROM shared_wardrobe ORDER BY created DESC, id DESC`).all(),
    photo: (id: string) => db.prepare("SELECT photo FROM shared_wardrobe WHERE id=?").get(id)?.photo as Uint8Array | undefined,
    publish(input: unknown) {
      const { name, tags, note, image } = upload.parse(input);
      const photo = Buffer.from(image.slice("data:image/jpeg;base64,".length), "base64");
      if (photo.length < 5 || photo[0] !== 255 || photo[1] !== 216 || photo[2] !== 255
        || photo.at(-2) !== 255 || photo.at(-1) !== 217) throw new z.ZodError([]);
      const id = randomUUID();
      const inserted = db.prepare(`INSERT INTO shared_wardrobe(id,name,tags,note,photo,created)
        SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM shared_wardrobe)<300`).run(id,name,tags,note,photo,Date.now());
      return inserted.changes ? id : null;
    },
    remove: (id: string) => db.prepare("DELETE FROM shared_wardrobe WHERE id=?").run(id).changes > 0,
  };
}
