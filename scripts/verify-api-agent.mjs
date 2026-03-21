import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const baseUrl = process.env.CODEX2API_BASE_URL ?? "http://127.0.0.1:3000";
const adminToken = process.env.CODEX2API_ADMIN_TOKEN ?? "";
const model = process.env.CODEX2API_MODEL ?? "gpt-5.4";
const workspaceId = process.env.CODEX2API_WORKSPACE_ID ?? "";
const imagePath = process.env.CODEX2API_IMAGE_PATH ?? path.join(repoRoot, "web.png");

class Codex2ApiAgent {
  constructor({ baseUrl, adminToken, model, workspaceId }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.adminToken = adminToken;
    this.model = model;
    this.workspaceId = workspaceId;
  }

  async chat(messages) {
    const headers = {
      "Content-Type": "application/json"
    };

    if (this.adminToken) {
      headers.Authorization = `Bearer ${this.adminToken}`;
    }

    const body = {
      model: this.model,
      messages,
      metadata: this.workspaceId ? { workspace_id: this.workspaceId } : undefined
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${response.status} ${JSON.stringify(payload)}`);
    }

    return payload;
  }
}

function escapePdfText(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function createSimplePdf(lines) {
  const streamLines = ["BT", "/F1 18 Tf", "40 780 Td"];
  lines.forEach((line, index) => {
    if (index > 0) {
      streamLines.push("0 -24 Td");
    }
    streamLines.push(`(${escapePdfText(line)}) Tj`);
  });
  streamLines.push("ET");

  const stream = streamLines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "latin1");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });

  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function detectMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function createFixtures() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex2api-agent-"));
  const txtPath = path.join(tempDir, "sample.txt");
  const pdfPath = path.join(tempDir, "sample.pdf");

  await fs.writeFile(txtPath, "HELLO_TXT_OK\nThis file is used for codex2api verification.\n", "utf8");
  await fs.writeFile(
    pdfPath,
    createSimplePdf(["HELLO_PDF_OK", "This PDF is used for codex2api verification."])
  );

  return { tempDir, txtPath, pdfPath };
}

function extractAssistantText(payload) {
  return payload?.choices?.[0]?.message?.content ?? "";
}

function assertMarker(name, value, marker) {
  if (!value.includes(marker)) {
    throw new Error(`${name} check failed: expected marker ${marker}, got: ${value}`);
  }
}

async function main() {
  const agent = new Codex2ApiAgent({ baseUrl, adminToken, model, workspaceId });
  const fixtures = await createFixtures();
  const txtBase64 = await fs.readFile(fixtures.txtPath, "base64");
  const pdfBase64 = await fs.readFile(fixtures.pdfPath, "base64");
  const imageBuffer = await fs.readFile(imagePath);
  const imageUrl = `data:${detectMimeType(imagePath)};base64,${imageBuffer.toString("base64")}`;

  try {
    const txtResult = await agent.chat([
      {
        role: "developer",
        content: "Reply concisely. Follow exact marker instructions."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Read the attached txt file and reply with the exact marker from it."
          },
          {
            type: "input_file",
            file: {
              filename: "sample.txt",
              mime_type: "text/plain",
              file_data: txtBase64
            }
          }
        ]
      }
    ]);

    const imgResult = await agent.chat([
      {
        role: "developer",
        content: "Reply concisely. Start the answer with IMAGE_OK."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "This request includes an image. Start with IMAGE_OK and then give a short Chinese description."
          },
          {
            type: "input_image",
            image_url: {
              url: imageUrl
            }
          }
        ]
      }
    ]);

    const pdfResult = await agent.chat([
      {
        role: "developer",
        content: "Reply concisely. Follow exact marker instructions."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Read the attached pdf and reply with the exact marker from it."
          },
          {
            type: "input_file",
            file: {
              filename: "sample.pdf",
              mime_type: "application/pdf",
              file_data: pdfBase64
            }
          }
        ]
      }
    ]);

    const txtText = extractAssistantText(txtResult);
    const imgText = extractAssistantText(imgResult);
    const pdfText = extractAssistantText(pdfResult);

    assertMarker("txt", txtText, "HELLO_TXT_OK");
    assertMarker("img", imgText, "IMAGE_OK");
    assertMarker("pdf", pdfText, "HELLO_PDF_OK");

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          model,
          txt: txtText,
          img: imgText,
          pdf: pdfText
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(fixtures.tempDir, { recursive: true, force: true });
  }
}

await main();
