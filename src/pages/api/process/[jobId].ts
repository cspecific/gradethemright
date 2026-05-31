import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// ─── DOCX extraction ──────────────────────────────────────────────────────────

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  while (pos < bytes.length - 30) {
    if (bytes[pos]===0x50&&bytes[pos+1]===0x4B&&bytes[pos+2]===0x03&&bytes[pos+3]===0x04) {
      const compression = bytes[pos+8]|(bytes[pos+9]<<8);
      const compSz  = bytes[pos+18]|(bytes[pos+19]<<8)|(bytes[pos+20]<<16)|(bytes[pos+21]<<24);
      const fnLen   = bytes[pos+26]|(bytes[pos+27]<<8);
      const exLen   = bytes[pos+28]|(bytes[pos+29]<<8);
      const fname   = new TextDecoder().decode(bytes.slice(pos+30,pos+30+fnLen));
      const dStart  = pos+30+fnLen+exLen;
      if (fname==='word/document.xml') {
        const compressed = bytes.slice(dStart,dStart+compSz);
        try {
          let xml: string;
          if (compression===0) { xml=new TextDecoder().decode(compressed); }
          else {
            const ds=new DecompressionStream('deflate-raw');
            const w=ds.writable.getWriter(),r=ds.readable.getReader();
            await w.write(compressed); await w.close();
            const chunks:Uint8Array[]=[]; let total=0;
            while(true){const{done,value}=await r.read();if(done)break;chunks.push(value);total+=value.length;}
            const out=new Uint8Array(total); let off=0;
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

// ─── PDF: local FlateDecode attempt ──────────────────────────────────────────

async function extractPdfTextLocal(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const raw   = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const si = raw.indexOf('stream', pos);
    if (si < 0) break;
    let sStart = -1;
    if (raw[si+6]==='\n') sStart=si+7;
    else if (raw[si+6]==='\r'&&raw[si+7]==='\n') sStart=si+8;
    if (sStart<0) { pos=si+1; continue; }

    const ei = raw.indexOf('endstream', sStart);
    if (ei<0) break;

    const header = raw.slice(Math.max(0,si-1000),si);
    const isFlate = /FlateDecode|\/Fl[\s/\]>]/.test(header);
    const streamBytes = bytes.slice(sStart, ei);
    let content = '';

    if (isFlate) {
      for (const fmt of ['deflate','deflate-raw'] as const) {
        try {
          const ds=new DecompressionStream(fmt);
          const w=ds.writable.getWriter(),r=ds.readable.getReader();
          await w.write(streamBytes.slice()); await w.close();
          const chunks:Uint8Array[]=[]; let total=0;
          while(true){const{done,value}=await r.read();if(done)break;chunks.push(value);total+=value.length;}
          const out=new Uint8Array(total); let off=0;
          for(const c of chunks){out.set(c,off);off+=c.length;}
          content=new TextDecoder('latin1').decode(out);
          break;
        } catch { continue; }
      }
    } else {
      content = raw.slice(sStart, ei);
    }

    if (content) {
      const tj    = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
      const tjArr = /\[([^\]]*)\]\s*TJ/g;
      let m: RegExpExecArray|null;
      while ((m=tj.exec(content))    !==null) { const t=m[1].replace(/\\n/g,' ').replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\'); if(/[a-zA-Z0-9]/.test(t)) parts.push(t); }
      while ((m=tjArr.exec(content)) !==null) { const items=m[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g)||[]; for(const it of items){const t=it.slice(1,-1);if(/[a-zA-Z0-9]/.test(t))parts.push(t);} }
    }
    pos = ei+9;
  }
  return parts.join(' ').replace(/\s+/g,' ').trim().slice(0,20000);
}

// ─── Eden AI helpers ──────────────────────────────────────────────────────────

function parseModel(modelId: string): { provider: string; model: string } {
  const [provider, ...rest] = modelId.split('/');
  return { provider, model: rest.join('/') };
}

async function edenChat(
  provider: string, model: string, apiKey: string,
  userText: string, system: string,
  fileBuf?: ArrayBuffer, fileName?: string,
  maxTokens = 2000
): Promise<string> {
  // Use multipart when file is attached so the model can read it natively
  let res: Response;

  if (fileBuf && fileName) {
    const form = new FormData();
    form.append('providers', provider);
    form.append('text', userText);
    form.append('chatbot_global_action', system);
    form.append('temperature', '0.3');
    form.append('max_tokens', String(maxTokens));
    if (model) form.append('settings', JSON.stringify({ [provider]: model }));
    const mime = fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf'
               : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    form.append('file', new Blob([fileBuf], { type: mime }), fileName);
    res = await fetch('https://api.edenai.run/v2/text/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
  } else {
    const body: Record<string,unknown> = {
      providers: provider, text: userText,
      chatbot_global_action: system, temperature: 0.3, max_tokens: maxTokens,
    };
    if (model) body.settings = { [provider]: model };
    res = await fetch('https://api.edenai.run/v2/text/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) throw new Error(`Eden AI ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json() as Record<string,any>;
  const pr = data[provider];
  if (!pr || pr.status!=='success') throw new Error(`Provider ${provider} error: ${JSON.stringify(pr).slice(0,200)}`);
  return pr.generated_text ?? '';
}

const GRADE_JSON = `{
  "grade": "2:1 (65%)",
  "grade_band": "2:1",
  "percentage": 65,
  "overall_feedback": "2-3 sentence overview",
  "strengths": ["s1","s2","s3"],
  "improvements": ["i1","i2","i3"],
  "referencing_feedback": "comment on referencing",
  "structure_comment": "comment on structure",
  "criteria": [{"name":"criterion","score":"65%","comment":"comment"}]
}`;

const SYSTEM = 'You are an expert academic assessor at a UK university. Return ONLY valid JSON with no markdown or preamble.';

// ─── Grade: text-based (DOCX or successful PDF extraction) ───────────────────

async function gradeFromText(
  briefText: string, assignText: string, refText: string|undefined,
  modelId: string, apiKey: string
): Promise<string> {
  const { provider, model } = parseModel(modelId);
  const prompt = `ASSIGNMENT BRIEF:\n${briefText.slice(0,5000)}\n\n${refText?`REFERENCING GUIDE:\n${refText.slice(0,2000)}\n\n`:''}STUDENT ASSIGNMENT:\n${assignText.slice(0,8000)}\n\nAssess this assignment. Return ONLY this JSON:\n${GRADE_JSON}\nUK grades: First 70%+, 2:1 60-69%, 2:2 50-59%, Third 40-49%, Fail <40%.`;
  return edenChat(provider, model, apiKey, prompt, SYSTEM);
}

// ─── Grade: file-based (PDF that resists local extraction) ───────────────────

async function gradeFromFiles(
  briefBuf: ArrayBuffer, briefName: string,
  assignBuf: ArrayBuffer, assignName: string,
  modelId: string, apiKey: string
): Promise<string> {
  const { provider, model } = parseModel(modelId);

  // Call 1: read brief
  const briefSummary = await edenChat(
    provider, model, apiKey,
    'Read this assignment brief and extract: marking criteria, learning outcomes, word count, any specific requirements. Be thorough.',
    'You are an academic assistant. Extract key information from the provided document.',
    briefBuf, briefName, 800
  );

  // Call 2: grade assignment using brief summary
  const gradePrompt = `Assignment requirements:\n${briefSummary}\n\nNow read and grade the attached student assignment. Return ONLY this JSON:\n${GRADE_JSON}\nUK grades: First 70%+, 2:1 60-69%, 2:2 50-59%, Third 40-49%, Fail <40%.`;
  return edenChat(provider, model, apiKey, gradePrompt, SYSTEM, assignBuf, assignName);
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
      await DB.prepare("UPDATE jobs SET status='error',error_message='Files missing from storage' WHERE id=?").bind(jobId).run();
      return fail('Files not found', 404);
    }

    const [briefBuf, assignBuf] = await Promise.all([briefObj.arrayBuffer(), assignObj.arrayBuffer()]);

    // Try local text extraction
    const isPdf = (n: string) => n.toLowerCase().endsWith('.pdf');
    const isDocx = (n: string) => n.toLowerCase().endsWith('.docx');

    let raw: string;

    if (isDocx(job.brief_name) && isDocx(job.assignment_name)) {
      // Both DOCX — extract locally and do one chat call
      const briefText  = await extractDocxText(briefBuf);
      const assignText = await extractDocxText(assignBuf);
      let refText: string|undefined;
      if (job.ref_guide_name) {
        const refObj = await FILES_BUCKET.get(`${jobId}/referencing/${job.ref_guide_name}`);
        if (refObj) refText = await extractDocxText(await refObj.arrayBuffer());
      }
      raw = await gradeFromText(briefText, assignText, refText, job.model, (env as any).EDEN_AI_KEY);
    } else if (isPdf(job.brief_name) || isPdf(job.assignment_name)) {
      // At least one PDF — try local extraction first
      const briefText  = isPdf(job.brief_name)  ? await extractPdfTextLocal(briefBuf)  : await extractDocxText(briefBuf);
      const assignText = isPdf(job.assignment_name) ? await extractPdfTextLocal(assignBuf) : await extractDocxText(assignBuf);

      if (briefText.length > 200 && assignText.length > 200) {
        // Local extraction worked
        let refText: string|undefined;
        if (job.ref_guide_name) {
          const refObj = await FILES_BUCKET.get(`${jobId}/referencing/${job.ref_guide_name}`);
          if (refObj) {
            const rb = await refObj.arrayBuffer();
            refText = isPdf(job.ref_guide_name) ? await extractPdfTextLocal(rb) : await extractDocxText(rb);
          }
        }
        raw = await gradeFromText(briefText, assignText, refText, job.model, (env as any).EDEN_AI_KEY);
      } else {
        // Fall back to file-based grading (model reads PDFs directly)
        raw = await gradeFromFiles(briefBuf, job.brief_name, assignBuf, job.assignment_name, job.model, (env as any).EDEN_AI_KEY);
      }
    } else {
      return fail('Unsupported file type. Please upload PDF or DOCX files.', 422);
    }

    // Parse JSON response
    let result: Record<string,unknown>;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m?m[0]:raw);
    } catch {
      await DB.prepare("UPDATE jobs SET status='error',error_message='AI returned invalid JSON. Please try again.' WHERE id=?").bind(jobId).run();
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
