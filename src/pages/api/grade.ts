import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, locals }) => {
  const { FILES_BUCKET, DB } = locals.runtime.env;

  try {
    const formData = await request.formData();
    const brief = formData.get('brief') as File | null;
    const referencingGuide = formData.get('referencing_guide') as File | null;
    const assignment = formData.get('assignment') as File | null;
    const model = formData.get('model') as string | null;

    // Validate required fields
    if (!brief || !assignment || !model) {
      return new Response(JSON.stringify({ error: 'Missing required fields: brief, assignment, and model are all required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate file types
    const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    for (const file of [brief, assignment, ...(referencingGuide ? [referencingGuide] : [])]) {
      if (!allowed.includes(file.type) && !file.name.match(/\.(pdf|doc|docx)$/i)) {
        return new Response(JSON.stringify({ error: `Invalid file type: ${file.name}. Only PDF and Word documents are accepted.` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Validate file sizes (10MB max each)
    const maxSize = 10 * 1024 * 1024;
    for (const file of [brief, assignment, ...(referencingGuide ? [referencingGuide] : [])]) {
      if (file.size > maxSize) {
        return new Response(JSON.stringify({ error: `File too large: ${file.name}. Maximum size is 10MB.` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Generate job ID
    const jobId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Upload files to R2
    const uploadFile = async (file: File, key: string) => {
      const buffer = await file.arrayBuffer();
      await FILES_BUCKET.put(key, buffer, {
        httpMetadata: { contentType: file.type },
        customMetadata: { originalName: file.name, jobId },
      });
    };

    await uploadFile(brief, `${jobId}/brief/${brief.name}`);
    await uploadFile(assignment, `${jobId}/assignment/${assignment.name}`);
    if (referencingGuide) {
      await uploadFile(referencingGuide, `${jobId}/referencing/${referencingGuide.name}`);
    }

    // Create job record in D1
    await DB.prepare(`
      INSERT INTO jobs (id, status, model, brief_name, assignment_name, ref_guide_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      jobId,
      'pending',
      model,
      brief.name,
      assignment.name,
      referencingGuide?.name ?? null,
      timestamp
    ).run();

    return new Response(JSON.stringify({ jobId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Grade API error:', err);
    return new Response(JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
