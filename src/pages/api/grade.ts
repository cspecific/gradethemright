import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async (context) => {
  const makeError = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const FILES_BUCKET = (env as any).FILES_BUCKET;
    const DB = (env as any).DB;

    if (!FILES_BUCKET) return makeError('R2 bucket binding missing. Check Cloudflare Pages settings.', 500);
    if (!DB) return makeError('D1 database binding missing. Check Cloudflare Pages settings.', 500);

    let formData: FormData;
    try {
      formData = await context.request.formData();
    } catch {
      return makeError('Could not parse form data.', 400);
    }

    const brief = formData.get('brief') as File | null;
    const referencingGuide = formData.get('referencing_guide') as File | null;
    const assignment = formData.get('assignment') as File | null;
    const model = formData.get('model') as string | null;

    if (!brief || !(brief instanceof File)) return makeError('Assignment brief is required.');
    if (!assignment || !(assignment instanceof File)) return makeError('Assignment file is required.');
    if (!model) return makeError('AI model selection is required.');

    const maxSize = 10 * 1024 * 1024;
    for (const file of [brief, assignment, ...(referencingGuide instanceof File ? [referencingGuide] : [])]) {
      if (file.size > maxSize) return makeError(`File too large: ${file.name}. Max 10MB.`);
    }

    const jobId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const uploadFile = async (file: File, key: string) => {
      const buffer = await file.arrayBuffer();
      await FILES_BUCKET.put(key, buffer, {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { originalName: file.name, jobId },
      });
    };

    await uploadFile(brief, `${jobId}/brief/${brief.name}`);
    await uploadFile(assignment, `${jobId}/assignment/${assignment.name}`);
    if (referencingGuide instanceof File) {
      await uploadFile(referencingGuide, `${jobId}/referencing/${referencingGuide.name}`);
    }

    await DB.prepare(
      `INSERT INTO jobs (id, status, model, brief_name, assignment_name, ref_guide_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      jobId,
      'pending',
      model,
      brief.name,
      assignment.name,
      referencingGuide instanceof File ? referencingGuide.name : null,
      timestamp
    ).run();

    return new Response(JSON.stringify({ jobId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('Grade API error:', err);
    return new Response(JSON.stringify({ error: err?.message ?? 'Unexpected error. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
