import { artifactDownloadUrl, type PipelineArtifact } from "@/lib/pipelines-api";

export interface ArtifactListProps {
  artifacts: PipelineArtifact[];
}

/** `1.4 MB` — bytes as a person reads them, not as a byte count. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the run produced, with a link to fetch the bytes (spec §9, §11).
 *
 * ## A link, not a fetch
 *
 * The route answers with the file and a `Content-Disposition` the browser turns
 * into a save. Fetching it in JS would pull the whole file into memory to
 * re-save it by hand, which is the wrong shape for the thing most runs deliver.
 *
 * The session rides in the query because a navigation cannot set a header — and
 * the server accepts it on **this** path only, which is why this is a link built
 * here rather than a URL the client forgets to scope.
 *
 * ## When the run produced nothing
 *
 * "No files yet" beside a completed run is a real state, and a silent empty
 * section would read as a control that failed. The reason is on screen: a run
 * with no artifact simply has not produced one.
 */
export function ArtifactList({ artifacts }: ArtifactListProps) {
  if (artifacts.length === 0) {
    return (
      <p className="small text-body-secondary mb-0">
        <i className="bi bi-paperclip me-1" aria-hidden="true" />
        No files yet.
      </p>
    );
  }
  return (
    <ul className="list-unstyled mb-0">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="d-flex align-items-center gap-2 py-1">
          <i className="bi bi-file-earmark" aria-hidden="true" />
          <a
            className="small text-truncate"
            href={artifactDownloadUrl(artifact.id)}
            download={artifact.filename}
          >
            {artifact.filename}
          </a>
          <span className="small text-body-secondary">{humanSize(artifact.size)}</span>
          {artifact.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && (
            <span className="badge text-bg-light border">DOCX</span>
          )}
        </li>
      ))}
    </ul>
  );
}
