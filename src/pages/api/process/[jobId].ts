import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// ─── DOCX extraction ──────────────────────────────────────────────────────────

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  while (pos < bytes.length - 30) {
    if (bytes[pos]===0x50&&bytes[pos+1]===0x4B&&bytes[pos+2]===0x03&&bytes[pos+3]===0x04) {
      const compression = bytes[pos+8]|(bytes[pos+9]<<8);
      const compSz = bytes[pos+18]|(bytes[pos+19]<<8)|(bytes[pos+20]<<16)|(bytes[pos+21]<<24);
      const fnLen  = bytes[pos+26]|(bytes[pos+27]<<8);
      const exLen  = bytes[pos+28]|(bytes[pos+29]<<8);
      const fname  = new TextDecoder().decode(bytes.slice(pos+30, pos+30+fnLen));
      const dStart = pos+30+fnLen+exLen;
      if (fname === 'word/document.xml') {
        const compressed = bytes.slice(dStart, dStart+compSz);
        try {
          let xml: string;
          if (compression===0) { xml=new TextDecoder().decode(compressed); }
          else {
            const ds=new DecompressionStream('deflate-raw');
            const w=ds.writable.getWriter(), r=ds.readable.getReader();
            await w.write(compressed); await w.close();
            const chunks: Uint8Array[]=[];let total=0;
            while(true){const{done,value}=await r.read();if(done)break;chunks.push(value);total+=value.length;}
            const out=new Uint8Array(total);let off=0;
            for(const c of chunks){out.set(c,off);off+=c.length;}
            xml=new TextDecoder().decode(out);
          }
          return xml.replace(/<w:t[^>]*>/g,'').replace(/<\/w:t>/g,' ').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,20000);
        } catch { return ''; }
      }
      const next=dStart+compSz; pos=next>pos?next:pos+1;
    } else pos++;
  }
  return '';
}

// ─── PDF: FlateDecode extraction (free, works for most digital PDFs) ──────────

async function extractPdfTextLocal(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const raw   = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];

  // Find compressed streams and decompress them
  const streamRe = /stream\r?\n/g;
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(raw)) !== null) {
    const sStart = sm.index + sm[0].length;
    const header = raw.slice(Math.max(0, sm.index - 600), sm.index);
    const eEnd   = raw.indexOf('endstream', sStart);
    if (eEnd < 0) continue;

    const streamBytes = bytes.slice(sStart, eEnd);
    let content = '';

    if (header.includes('FlateDecode') || header.includes('/Fl\n') || header.includes('/Fl ')) {
      try {
        // Try deflate first, then deflate-raw
        for (const fmt of ['deflate', 'deflate-raw'] as const) {
          try {
            const ds = new DecompressionStream(fmt);
            const w = ds.writable.getWriter(), r = ds.readable.getReader();
            await w.write(streamBytes); await w.close();
            const chunks: Uint8Array[] = []; let total = 0;
            while (true) { const {done,value}=await r.read(); if(done)break; chunks.push(value); total+=value.length; }
            const out = new Uint8Array(total); let off = 0;
            for (const c of chunks) { out.set(c,off); off+=c.length; }
            content = new TextDecoder('latin1').decode(out);
            break;
          } catch { continue; }
        }
      } catch { /* skip */ }
    } else {
      content = raw.slice(sStart, eEnd);
    }

    if (!content) continue;

    // Extract Tj / TJ operators
    const tj    = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
    const tjArr = /\[([^\]]*)\]\s*TJ/g;
    let m: RegExpExecArray | null;
    while ((m = tj.exec(content))    !== null) parts.push(m[1].replace(/\\n/g,' ').replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\'));
    while ((m = tjArr.exec(content)) !== null) {
      const items = m[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g)||[];
      for (const it of items) parts.push(it.slice(1,-1));
    }
  }

  return parts.join(' ').replace(/\s+/g,' ').trim().slice(0,20000);
}

// ─── PDF: Eden AI OCR fallback ────────────────────────────────────────────────

async function extractPdfTextViaOCR(buffer: ArrayBuffer, filename: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('providers', 'amazon,microsoft');
  form.append('language', 'en');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);

  const res  = await fetch('https://api.edenai.run/v2/ocr/ocr', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`OCR HTTP ${res.status}: ${raw.slice(0,200)}`);

  let data: Record<string,any>;
  try { data = JSON.parse(raw); } catch { throw new Error(`OCR bad JSON: ${raw.slice(0,200)}`); }

  const errors: string[] = [];
  for (const p of ['amazon','microsoft','google','api4ai']) {
    const pr = data[p];
    if (pr?.status==='success' && pr?.text?.trim()) return (pr.text as string).slice(0,20000);
    if (pr?.status==='fail')   errors.push(`${p}: ${pr?.error?.message||'unknown'}`);
  }

  throw new Error(errors.length ? `OCR providers failed — ${errors.join('; ')}` : 'OCR returned no text');
}

// ─── Main text extractor ──────────────────────────────────────────────────────

async function extractText(buffer: ArrayBuffer, filename: string, apiKey: string): Promise<string> {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.docx')) return extractDocxText(buffer);

  if (lower.endsWith('.pdf')) {
    // Try local extraction first (free + fast)
    const local = await extractPdfTextLocal(buffer);
    if (local.length > 100) return local;
    // Fall back to Eden AI OCR
    return extractPdfTextViaOCR(buffer, filename, apiKey);
  }

  return new TextDecoder('utf-8',{fatal:false}).decode(buffer).slice(0,20000);
}

// ─── Eden AI chat ─────────────────────────────────────────────────────────────

function buildPrompt(brief: string, assignment: string, refGuide?: string): string {
  return `ASSIGNMENT BRIEF:\n${brief.slice(0,5000)}\n\n${refGuide?`REFERENCING GUIDE:\n${refGuide.slice(0,2000)}\n\n`:''}STUDENT ASSIGNMENT:\n${assignment.slice(0,8000)}\n\nAssess this student assignment against the brief. Return ONLY valid JSON:\n{\n  "grade": "2:1 (65%)",\n  "grade_band": "2:1",\n  "percentage": 65,\n  "overall_feedback": "2-3 sentence overview",\n  "strengths": ["s1","s2","s3"],\n  "improvements": ["i1","i2","i3"],\n  "referencing_feedback": "comment",\n  "structure_comment": "comment",\n  "criteria": [{"name":"criterion","score":"65%","comment":"comment"}]\n}\nUK grades: First 70%+, 2:1 60-69%, 2:2 50-59%, Third 40-49%, Fail <40%.`;
}

async function callEdenAI(prompt: string, modelId: string, apiKey: string): Promise<string> {
  const [provider, ...rest] = modelId.split('/');
  const model = rest.join('/');
  const body: Record<string,unknown> = {
    providers: provider,
    text: prompt,
    chatbot_global_action: 'You are an expert academic assessor. Return ONLY valid JSON.',
    temperature: 0.3,
    max_tokens: 2000,
  };
  if (model) body.settings = { [provider]: model };

  const res = await fetch('https://api.edenai.run/v2/text/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Eden AI chat ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json() as Record<string,any>;
  const pr = data[provider];
  if (!pr || pr.status!=='success') throw new Error(`Provider error: ${JSON.stringify(pr).slice(0,200)}`);
  return pr.generated_text ?? '';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async (context) => {
  const fail = (msg: string, status=500) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: {'Content-Type':'application/json'} });

  const { jobId } = context.params;
  if (!jobId) return fail('Missing job ID', 400);

  const edenKey      = (env as any).EDEN_AI_KEY   as string|undefined;
  const FILES_BUCKET = (env as any).FILES_BUCKET  as R2Bucket|undefined;
  const DB           = (env as any).DB            as D1Database|undefined;

  if (!edenKey)      return fail('EDEN_AI_KEY not set');
  if (!FILES_BUCKET) return fail('FILES_BUCKET binding missing');
  if (!DB)           return fail('DB binding missing');

  try {
    const job = await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>();
    if (!job) return fail('Job not found', 404);
    if (job.status==='done')  return new Response(JSON.stringify({status:'done',result:JSON.parse(job.feedback)}),{status:200,headers:{'Content-Type':'application/json'}});
    if (job.status==='error') return fail(job.error_message||'Previous attempt failed');

    await DB.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(jobId).run();

    const [briefObj, assignObj] = await Promise.all([
      FILES_BUCKET.get(`${jobId}/brief/${job.brief_name}`),
      FILES_BUCKET.get(`${jobId}/assignment/${job.assignment_name}`),
    ]);
    if (!briefObj||!assignObj) {
      await DB.prepare("UPDATE jobs SET status='error',error_message='Files missing' WHERE id=?").bind(jobId).run();
      return fail('Files not found', 404);
    }

    const [briefBuf, assignBuf] = await Promise.all([briefObj.arrayBuffer(), assignObj.arrayBuffer()]);
    const briefText  = await extractText(briefBuf,  job.brief_name,      edenKey);
    const assignText = await extractText(assignBuf, job.assignment_name, edenKey);

    if (!briefText.trim()||!assignText.trim()) {
      const which = !briefText.trim()?'brief':'assignment';
      await DB.prepare("UPDATE jobs SET status='error',error_message=? WHERE id=?").bind(`Could not extract text from ${which}`,jobId).run();
      return fail(`Text extraction failed for ${which}`, 422);
    }

    let refText: string|undefined;
    if (job.ref_guide_name) {
      const refObj = await FILES_BUCKET.get(`${jobId}/referencing/${job.ref_guide_name}`);
      if (refObj) refText = await extractText(await refObj.arrayBuffer(), job.ref_guide_name, edenKey);
    }

    const raw = await callEdenAI(buildPrompt(briefText, assignText, refText), job.model, edenKey);

    let result: Record<string,unknown>;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m?m[0]:raw);
    } catch {
      await DB.prepare("UPDATE jobs SET status='error',error_message='AI returned invalid JSON' WHERE id=?").bind(jobId).run();
      return fail('AI returned invalid JSON', 500);
    }

    await DB.prepare("UPDATE jobs SET status='done',grade=?,feedback=?,completed_at=? WHERE id=?")
      .bind(result.grade as string, JSON.stringify(result), new Date().toISOString(), jobId).run();

    return new Response(JSON.stringify({status:'done',result}),{status:200,headers:{'Content-Type':'application/json'}});

  } catch (err: any) {
    console.error('process error:', err);
    try { await DB.prepare("UPDATE jobs SET status='error',error_message=? WHERE id=?").bind(err?.message??'Unknown error',jobId).run(); } catch {}
    return fail(err?.message??'Processing failed');
  }
};
