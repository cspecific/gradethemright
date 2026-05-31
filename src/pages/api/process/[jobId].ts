import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// ─── DOCX text extraction (ZIP + deflate-raw) ─────────────────────────────────

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  while (pos < bytes.length - 30) {
    if (bytes[pos] === 0x50 && bytes[pos+1] === 0x4B &&
        bytes[pos+2] === 0x03 && bytes[pos+3] === 0x04) {

      const compression  = bytes[pos+8]  | (bytes[pos+9]  << 8);
      const compressedSz = bytes[pos+18] | (bytes[pos+19] << 8) | (bytes[pos+20] << 16) | (bytes[pos+21] << 24);
      const filenameLen  = bytes[pos+26] | (bytes[pos+27] << 8);
      const extraLen     = bytes[pos+28] | (bytes[pos+29] << 8);
      const filename     = new TextDecoder().decode(bytes.slice(pos+30, pos+30+filenameLen));
      const dataStart    = pos + 30 + filenameLen + extraLen;

      if (filename === 'word/document.xml') {
        const compressed = bytes.slice(dataStart, dataStart + compressedSz);
        try {
          let xmlText: string;
          if (compression === 0) {
            xmlText = new TextDecoder().decode(compressed);
          } else {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            await writer.write(compressed);
            await writer.close();
            const chunks: Uint8Array[] = [];
            let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value); total += value.length;
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            xmlText = new TextDecoder().decode(out);
          }
          return xmlText
            .replace(/<w:t[^>]*>/g, '')
            .replace(/<\/w:t>/g, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 20000);
        } catch { return ''; }
      }

      const next = dataStart + compressedSz;
      pos = next > pos ? next : pos + 1;
    } else {
      pos++;
    }
  }
  return '';
}

// ─── PDF text extraction via Eden AI OCR ─────────────────────────────────────

async function extractPdfTextViaOCR(buffer: ArrayBuffer, filename: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('providers', 'amazon');
  form.append('language', 'en');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);

  const res = await fetch('https://api.edenai.run/v2/ocr/ocr', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OCR request failed ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, any>;

  for (const provider of ['amazon', 'microsoft', 'google', 'api4ai']) {
    const p = data[provider];
    if (p?.status === 'success' && p?.text?.trim()) {
      return (p.text as string).slice(0, 20000);
    }
  }

  throw new Error('OCR returned no usable text. The PDF may be scanned/image-based without selectable text.');
}

// ─── Route text extraction by file type ──────────────────────────────────────

async function extractText(buffer: ArrayBuffer, filename: string, apiKey: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) return extractDocxText(buffer);
  if (lower.endsWith('.pdf'))  return extractPdfTextViaOCR(buffer, filename, apiKey);
  // Fallback: try as plain text
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).slice(0, 20000);
}

// ─── Eden AI chat call ────────────────────────────────────────────────────────

function parseModelId(modelId: string): { provider: string; model: string } {
  const [provider, ...rest] = modelId.split('/');
  return { provider, model: rest.join('/') };
}

function buildPrompt(brief: string, assignment: string, refGuide?: string): string {
  return `ASSIGNMENT BRIEF:
${brief.slice(0, 5000)}

${refGuide ? `REFERENCING GUIDE:\n${refGuide.slice(0, 2000)}\n\n` : ''}STUDENT ASSIGNMENT:
${assignment.slice(0, 8000)}

Assess this student assignment against the brief. Return ONLY valid JSON — no markdown, no preamble:
{
  "grade": "2:1 (65%)",
  "grade_band": "2:1",
  "percentage": 65,
  "overall_feedback": "2-3 sentence overview",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "improvements": ["area 1", "area 2", "area 3"],
  "referencing_feedback": "comment on referencing",
  "structure_comment": "comment on structure",
  "criteria": [{"name": "criterion", "score": "65%", "comment": "comment"}]
}
UK grades: First 70%+, 2:1 60-69%, 2:2 50-59%, Third 40-49%, Fail <40%.`;
}

async function callEdenAI(prompt: string, modelId: string, apiKey: string): Promise<string> {
  const { provider, model } = parseModelId(modelId);
  const body: Record<string, unknown> = {
    providers: provider,
    text: prompt,
    chatbot_global_action: 'You are an expert academic assessor at a UK university. Return ONLY valid JSON.',
    temperature: 0.3,
    max_tokens: 2000,
  };
  if (model) body.settings = { [provider]: model };

  const res = await fetch('https://api.edenai.run/v2/text/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Eden AI chat error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json() as Record<string, any>;
  const pr = data[provider];
  if (!pr || pr.status !== 'success') throw new Error(`Provider error: ${JSON.stringify(pr).slice(0, 200)}`);
  return pr.generated_text ?? '';
}

// ─── API Route ────────────────────────────────────────────────────────────────

export const POST: APIRoute = async (context) => {
  const fail = (msg: string, status = 500) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

  const { jobId } = context.params;
  if (!jobId) return fail('Missing job ID', 400);

  const edenKey      = (env as any).EDEN_AI_KEY    as string | undefined;
  const FILES_BUCKET = (env as any).FILES_BUCKET   as R2Bucket | undefined;
  const DB           = (env as any).DB             as D1Database | undefined;

  if (!edenKey)      return fail('EDEN_AI_KEY secret not configured');
  if (!FILES_BUCKET) return fail('R2 FILES_BUCKET binding missing');
  if (!DB)           return fail('D1 DB binding missing');

  try {
    const job = await DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
    if (!job) return fail('Job not found', 404);

    if (job.status === 'done') {
      return new Response(JSON.stringify({ status: 'done', result: JSON.parse(job.feedback) }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (job.status === 'error') return fail(job.error_message || 'Previous attempt failed');

    await DB.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(jobId).run();

    const [briefObj, assignObj] = await Promise.all([
      FILES_BUCKET.get(`${jobId}/brief/${job.brief_name}`),
      FILES_BUCKET.get(`${jobId}/assignment/${job.assignment_name}`),
    ]);

    if (!briefObj || !assignObj) {
      await DB.prepare("UPDATE jobs SET status='error', error_message='Files missing from storage' WHERE id=?").bind(jobId).run();
      return fail('Files not found in R2', 404);
    }

    const [briefBuf, assignBuf] = await Promise.all([briefObj.arrayBuffer(), assignObj.arrayBuffer()]);

    const briefText  = await extractText(briefBuf,  job.brief_name,      edenKey);
    const assignText = await extractText(assignBuf, job.assignment_name, edenKey);

    if (!briefText.trim() || !assignText.trim()) {
      const which = !briefText.trim() ? 'brief' : 'assignment';
      await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?")
        .bind(`Could not extract text from ${which}.`, jobId).run();
      return fail(`Text extraction failed for ${which}`, 422);
    }

    let refText: string | undefined;
    if (job.ref_guide_name) {
      const refObj = await FILES_BUCKET.get(`${jobId}/referencing/${job.ref_guide_name}`);
      if (refObj) refText = await extractText(await refObj.arrayBuffer(), job.ref_guide_name, edenKey);
    }

    const raw = await callEdenAI(buildPrompt(briefText, assignText, refText), job.model, edenKey);

    let result: Record<string, unknown>;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      await DB.prepare("UPDATE jobs SET status='error', error_message='AI returned invalid JSON' WHERE id=?").bind(jobId).run();
      return fail('AI returned invalid JSON', 500);
    }

    await DB.prepare("UPDATE jobs SET status='done', grade=?, feedback=?, completed_at=? WHERE id=?")
      .bind(result.grade as string, JSON.stringify(result), new Date().toISOString(), jobId).run();

    return new Response(JSON.stringify({ status: 'done', result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('process error:', err);
    try { await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?").bind(err?.message ?? 'Unknown error', jobId).run(); } catch {}
    return fail(err?.message ?? 'Processing failed');
  }
};
