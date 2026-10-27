// src/modules/projects/actions.ts
// Server actions for /projects: ProjectReference CRUD (plain object payloads,
// same style as the customers module) and the PO attachment upload/remove
// (FormData, because they carry a File). Input is re-validated at the
// boundary, authorization runs in the service (assertCan — VIEWER gets 403 on
// writes), and ids from another organization answer 404 (IDOR guard in
// getProjectForScope).

"use server";

import {
  actionRequest,
  formDataString,
  toActionError,
  zodFailure,
} from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/clerk";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import { projectFormSchema, type ProjectFormValues } from "@/modules/projects/schema";
import {
  createProject,
  deleteProject,
  removeProjectAttachment,
  updateProject,
  uploadProjectAttachment,
} from "@/modules/projects/service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

export async function createProjectAction(
  values: ProjectFormValues,
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const ctx = await serviceContext();
    const parsed = projectFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const project = await createProject(parsed.data, ctx);
    return apiOk({ projectId: project.id });
  } catch (error) {
    return toActionError("projects.actions", error);
  }
}

export async function updateProjectAction(
  values: ProjectFormValues & { projectId: string },
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.projectId) return apiFailure("VALIDATION_ERROR", "Project tidak valid.");

    const parsed = projectFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const project = await updateProject(values.projectId, parsed.data, ctx);
    return apiOk({ projectId: project.id });
  } catch (error) {
    return toActionError("projects.actions", error);
  }
}

/** Hard delete — the UI asks for confirmation first (confirm dialog). */
export async function deleteProjectAction(values: {
  projectId: string;
}): Promise<ActionResult<{ projectId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.projectId) return apiFailure("VALIDATION_ERROR", "Project tidak valid.");

    const project = await deleteProject(values.projectId, ctx);
    return apiOk({ projectId: project.id });
  } catch (error) {
    return toActionError("projects.actions", error);
  }
}

/**
 * PO upload: size and MIME are decided SERVER-side by content sniffing
 * (StorageService → validateUpload), never by the filename or the declared
 * type — a PDF named .png is judged as PDF, a 3 MB file is rejected at 2 MB.
 */
export async function uploadProjectAttachmentAction(
  form: FormData,
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const ctx = await serviceContext();
    const projectId = formDataString(form, "projectId");
    if (!projectId) return apiFailure("VALIDATION_ERROR", "Project tidak valid.");

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return apiFailure("VALIDATION_ERROR", "File lampiran wajib dipilih.");
    }

    const project = await uploadProjectAttachment(projectId, file, ctx);
    return apiOk({ projectId: project.id });
  } catch (error) {
    return toActionError("projects.actions", error);
  }
}

export async function removeProjectAttachmentAction(
  values: { projectId: string },
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.projectId) return apiFailure("VALIDATION_ERROR", "Project tidak valid.");

    const project = await removeProjectAttachment(values.projectId, ctx);
    return apiOk({ projectId: project.id });
  } catch (error) {
    return toActionError("projects.actions", error);
  }
}
