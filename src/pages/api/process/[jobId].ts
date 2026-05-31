import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// ─── Text Extraction ───────────────────────────────────────────────────────────

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  while (pos < bytes.length - 30) {
    // ZIP local file header: PK\x03\x04
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
              chunks.push(value);
              total += value.length;
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            xmlText = new TextDecoder().decode(out);
          }
          return xmlText
            .replace(/<w:t[^>]*>/g, '')
            .replace(/<\/w:t>/g, ' ')
            .replace(/<w:p[>/][^>]*>/g, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 20000);
        } catch {
          return '';
        }
      }

      const next = dataStart + compressedSz;
      if (next > pos) pos = next; else pos++;
    } else {
      pos++;
    }
  }
  return '';
}

function extractPdfText(buffer: ArrayBuffer): string {
  try {
    const text = new TextDecoder('latin1').decode(buffer);
    const parts: string[] = [];

    // BT ... ET blocks
    const btEt = /BT([\s\S]{1,3000}?)ET/g;
    let m: RegExpExecArray | null;
    while ((m = btEt.exec(text)) !== null) {
      const block = m[1];
      // Tj
      const tj = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
      let t: RegExpExecArray | null;
      while ((t = tj.exec(block)) !== null) {
        parts.push(t[1].replace(/\\n/g,' ').replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\'));
      }
      // TJ
      const tjarr = /\[([^\]]*)\]\s*TJ/g;
      while ((t = tjarr.exec(block)) !== null) {
        const items = t[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) || [];
        for (const it of items) parts.push(it.slice(1,-1));
      }
    }

    return parts.join(' ').replace(/\s+/g,' ').trim().slice(0, 20000);
  } catch {
    return '';
  }
}

async function extractText(buffer: ArrayBuffer, filename: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) return extractDocxText(buffer);
  if (lower.endsWith('.pdf'))  return extractPdfText(buffer);
  return new TextDecoder().decode(buffer).slice(0, 20000);
}

// ─── Eden AI ──────────────────────────────────────────────────────────────────

function parseModelId(modelId: string): { provider: string; model: string } {
  const [provider, ...rest] = modelId.split('/');
  return { provider, model: rest.join('/') };
}

function buildPrompt(brief: string, assignment: string, refGuide?: string): string {
  return `ASSIGNMENT BRIEF:
${brief.slice(0, 5000)}

${refGuide ? `REFERENCING GUIDE:\n${refGuide.slice(0, 2000)}\n\n` : ''}STUDENT ASSIGNMENT:
${assignment.slice(0, 8000)}

Assess this student assignment against the brief above. Return ONLY a valid JSON object — no markdown, no explanation, just JSON:
{
  "grade": "2:1 (65%)",
  "grade_band": "2:1",
  "percentage": 65,
  "overall_feedback": "2-3 sentence overview of the work",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "improvements": ["improvement area 1", "improvement area 2", "improvement area 3"],
  "referencing_feedback": "comment on referencing quality",
  "structure_comment": "comment on structure and organisation",
  "criteria": [
    {"name": "criterion from brief", "score": "65%", "comment": "brief comment"}
  ]
}

UK grading: First 70%+, 2:1 60-69%, 2:2 50-59%, Third 40-49%, Fail below 40%.`;
}

async function callEdenAI(prompt: string, modelId: string, apiKey: string): Promise<string> {
  const { provider, model } = parseModelId(modelId);

  const body: Record<string, unknown> = {
    providers: provider,
    text: prompt,
    chatbot_global_action: 'You are an expert academic assessor at a UK university. Return ONLY valid JSON — no markdown, no explanation.',
    temperature: 0.3,
    max_tokens: 2000,
  };
  if (model) body.settings = { [provider]: model };

  const res = await fetch('https://api.edenai.run/v2/text/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Eden AI error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json() as Record<string, any>;
  const providerRes = data[provider];

  if (!providerRes || providerRes.status !== 'success') {
    throw new Error(`Provider error: ${JSON.stringify(providerRes).slice(0, 300)}`);
  }

  return providerRes.generated_text ?? '';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async (context) => {
  const fail = (msg: string, status = 500) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

  const { jobId } = context.params;
  if (!jobId) return fail('Missing job ID', 400);

  const edenKey     = (env as any).EDEN_AI_KEY   as string | undefined;
  const FILES_BUCKET= (env as any).FILES_BUCKET  as R2Bucket | undefined;
  const DB          = (env as any).DB             as D1Database | undefined;

  if (!edenKey)      return fail('EDEN_AI_KEY secret not set');
  if (!FILES_BUCKET) return fail('R2 FILES_BUCKET binding missing');
  if (!DB)           return fail('D1 DB binding missing');

  try {
    // ── Fetch job ──
    const job = await DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
    if (!job) return fail('Job not found', 404);

    if (job.status === 'done') {
      return new Response(JSON.stringify({ status: 'done', result: JSON.parse(job.feedback) }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (job.status === 'error') return fail(job.error_message || 'Previous grading attempt failed');

    // ── Mark as processing ──
    await DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('processing', jobId).run();

    // ── Download files from R2 ──
    const [briefObj, assignObj] = await Promise.all([
      FILES_BUCKET.get(`${jobId}/brief/${job.brief_name}`),
      FILES_BUCKET.get(`${jobId}/assignment/${job.assignment_name}`),
    ]);

    if (!briefObj || !assignObj) {
      await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?")
        .bind('Files missing from storage', jobId).run();
      return fail('Files not found in R2', 404);
    }

    const [briefBuf, assignBuf] = await Promise.all([briefObj.arrayBuffer(), assignObj.arrayBuffer()]);
    const briefText = await extractText(briefBuf, job.brief_name);
    const assignText = await extractText(assignBuf, job.assignment_name);

    if (!briefText.trim() || !assignText.trim()) {
      const which = !briefText.trim() ? 'brief' : 'assignment';
      await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?")
        .bind(`Could not extract text from ${which}. Use a text-based PDF or DOCX (not scanned).`, jobId).run();
      return fail(`Text extraction failed for ${which}`, 422);
    }

    let refText: string | undefined;
    if (job.ref_guide_name) {
      const refObj = await FILES_BUCKET.get(`${jobId}/referencing/${job.ref_guide_name}`);
      if (refObj) refText = await extractText(await refObj.arrayBuffer(), job.ref_guide_name);
    }

    // ── Call Eden AI ──
    const prompt = buildPrompt(briefText, assignText, refText);
    const raw = await callEdenAI(prompt, job.model, edenKey);

    // ── Parse JSON response ──
    let result: Record<string, unknown>;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?")
        .bind('AI returned invalid JSON. Please try again.', jobId).run();
      return fail('Invalid AI response', 500);
    }

    // ── Store result ──
    await DB.prepare(
      "UPDATE jobs SET status='done', grade=?, feedback=?, completed_at=? WHERE id=?"
    ).bind(result.grade as string, JSON.stringify(result), new Date().toISOString(), jobId).run();

    return new Response(JSON.stringify({ status: 'done', result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('process error:', err);
    try {
      await DB.prepare("UPDATE jobs SET status='error', error_message=? WHERE id=?")
        .bind(err?.message ?? 'Unknown error', jobId).run();
    } catch {}
    return fail(err?.message ?? 'Processing failed');
  }
};
