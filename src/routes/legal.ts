import { PrismaClient } from "@prisma/client";
import { Router } from "express";

const DEFAULT_PRIVACY_HTML = `
<!doctype html>
<html lang="az">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Məxfilik Siyasəti</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;padding:20px;}
    h1,h2{line-height:1.25}
    a{word-break:break-all}
  </style>
</head>
<body>
  <h1>Məxfilik Siyasəti</h1>
  <p>Son yenilənmə tarixi: 2026-01-06</p>
  <p>Bu mətn admin paneldən redaktə edilə bilər.</p>
</body>
</html>
`;

const DEFAULT_TERMS_HTML = `
<!doctype html>
<html lang="az">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>İstifadə Şərtləri</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;padding:20px;}
    h1,h2{line-height:1.25}
    a{word-break:break-all}
  </style>
</head>
<body>
  <h1>İstifadə Şərtləri</h1>
  <p>Son yenilənmə tarixi: 2026-01-06</p>
  <p>Bu mətn admin paneldən redaktə edilə bilər.</p>
</body>
</html>
`;

function normalizeType(raw: string) {
  const t = String(raw || "").toUpperCase();
  if (t === "PRIVACY") return "PRIVACY";
  if (t === "TERMS") return "TERMS";
  return null;
}

function defaultFor(type: "PRIVACY" | "TERMS") {
  return type === "PRIVACY"
    ? { title: "Məxfilik Siyasəti", content: DEFAULT_PRIVACY_HTML }
    : { title: "İstifadə Şərtləri", content: DEFAULT_TERMS_HTML };
}

export function legalRouter(prisma: PrismaClient) {
  const r = Router();

  // Public: return HTML (or plain text) for legal pages.
  r.get("/:type", async (req, res) => {
    const type = normalizeType(req.params.type);
    if (!type) return res.status(400).json({ error: "Invalid type" });

    const page = await prisma.legalPage.findUnique({ where: { type: type as any } });

    // Create defaults lazily on first access.
    if (!page) {
      const def = defaultFor(type);
      const created = await prisma.legalPage.create({
        data: {
          type: type as any,
          title: def.title,
          content: def.content,
          updatedById: null,
        },
      });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(created.content);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(page.content);
  });

  // JSON variant (admin/mobile can use)
  r.get("/:type/json", async (req, res) => {
    const type = normalizeType(req.params.type);
    if (!type) return res.status(400).json({ error: "Invalid type" });

    const page = await prisma.legalPage.findUnique({ where: { type: type as any } });
    if (!page) {
      const def = defaultFor(type);
      const created = await prisma.legalPage.create({
        data: {
          type: type as any,
          title: def.title,
          content: def.content,
          updatedById: null,
        },
      });
      return res.json(created);
    }
    return res.json(page);
  });

  return r;
}
