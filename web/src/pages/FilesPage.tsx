import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  ArrowUp,
  Download,
  FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  Toast,
  useToast,
} from "@/ui";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api } from "@/lib/api";
import type { ManagedFileEntry, ManagedFilesResponse } from "@/lib/api";
import { PluginSlot } from "@/plugins";
import { errorMessage } from "@/lib/api-error";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function joinPath(base: string, name: string): string {
  const cleanName = name.trim().replace(/^[\\/]+/, "");
  if (!cleanName) return base;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (!base || base.endsWith("/") || base.endsWith("\\")) return `${base}${cleanName}`;
  return `${base}${separator}${cleanName}`;
}

function formatBytes(size: number | null): string {
  if (size === null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function downloadDataUrl(dataUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = name || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function displayPath(path: string | null | undefined): string {
  return path?.trim() || "Files";
}

function transferHasFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export default function FilesPage() {
  const { toast, showToast } = useToast();
  const { setAfterTitle, setEnd } = usePageHeader();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);
  const [pathInput, setPathInput] = useState("");
  const [listing, setListing] = useState<ManagedFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ManagedFileEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activePath = listing?.path ?? currentPath ?? "";
  const canChangePath = listing?.can_change_path ?? false;
  const canUpload = Boolean(activePath) && !uploading;
  const headerPath = displayPath(listing?.locked_root ?? listing?.path ?? currentPath);

  const load = useCallback(
    async (path = currentPath) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listFiles(path);
        setListing(result);
        setCurrentPath(result.path);
        setPathInput(result.path);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [currentPath],
  );

  useEffect(() => {
    // Existing dashboard data pages fetch from effects; keep this local and explicit
    // until the shared lint profile is updated for async page loaders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(currentPath);
  }, [currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAfterTitle(
      <Badge tone="outline" className="text-truncate files-path-badge" title={headerPath}>
        {headerPath}
      </Badge>,
    );
    setEnd(
      <div className="d-flex align-items-center gap-2">
        <Button
          ghost
          size="icon"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh files"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>,
    );
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [headerPath, load, loading, setAfterTitle, setEnd]);

  const openDirectory = (entry: ManagedFileEntry) => {
    if (entry.is_directory) {
      setCurrentPath(entry.path);
    }
  };

  const goToPath = async () => {
    const nextPath = pathInput.trim();
    if (!nextPath) {
      showToast("Path required", "error");
      return;
    }
    await load(nextPath);
  };

  const createDirectory = async () => {
    const name = folderName.trim();
    if (!activePath) {
      showToast("Directory unavailable", "error");
      return;
    }
    if (!name) {
      showToast("Folder name required", "error");
      return;
    }
    setCreating(true);
    try {
      await api.createDirectory(joinPath(activePath, name));
      setFolderName("");
      setCreateDialogOpen(false);
      showToast("Folder created", "success");
      await load();
    } catch (e) {
      showToast(`Create failed: ${errorMessage(e)}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await api.uploadFile(joinPath(activePath, file.name), file, true);
      }
      showToast(`${files.length} file${files.length === 1 ? "" : "s"} uploaded`, "success");
      await load();
    } catch (e) {
      showToast(`Upload failed: ${errorMessage(e)}`, "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!canUpload || !transferHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!canUpload || !transferHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!canUpload || !transferHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingFiles(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!canUpload) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    void uploadFiles(event.dataTransfer.files);
  };

  const downloadFile = async (entry: ManagedFileEntry) => {
    if (entry.is_directory) return;
    try {
      const file = await api.readFile(entry.path);
      downloadDataUrl(file.data_url, file.name);
    } catch (e) {
      showToast(`Download failed: ${errorMessage(e)}`, "error");
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteFile(pendingDelete.path, pendingDelete.is_directory);
      showToast("Deleted", "success");
      setPendingDelete(null);
      await load();
    } catch (e) {
      showToast(`Delete failed: ${errorMessage(e)}`, "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="d-flex flex-column gap-4 overflow-hidden">
      <Toast toast={toast} />
      <PluginSlot name="files:top" />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="d-none"
        onChange={(event) => void uploadFiles(event.currentTarget.files)}
      />

      <div className="d-flex flex-column flex-xl-row flex-xl-wrap align-items-xl-center justify-content-between gap-3">
        {canChangePath ? (
          <form
            className="d-flex flex-grow-1 align-items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void goToPath();
            }}
          >
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              aria-label="Path"
              placeholder="Path"
              className="flex-grow-1 font-monospace"
            />
            <Button type="submit" size="sm" outlined>
              Go
            </Button>
          </form>
        ) : (
          <div className="text-body-secondary font-monospace text-truncate files-path-readout" title={activePath}>
            {activePath}
          </div>
        )}
        <div className="d-flex flex-wrap align-items-center gap-2">
          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canUpload}
            size="sm"
            outlined
            prefix={uploading ? <Spinner /> : <Upload />}
          >
            Upload
          </Button>
          <Button
            type="button"
            onClick={() => setCreateDialogOpen(true)}
            disabled={!activePath}
            size="sm"
            outlined
            prefix={<FolderPlus />}
          >
            Create
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => canUpload && fileInputRef.current?.click()}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={!canUpload}
        aria-label="Upload files"
        className={`dropzone w-100 d-flex align-items-center justify-content-between gap-3 p-3${ draggingFiles ? " dropzone-active" : "" }`}
      >
        <span className="d-flex align-items-center gap-3 min-w-0">
          <span className="dropzone-icon d-flex align-items-center justify-content-center">
            {uploading ? <Spinner /> : <Upload className="files-icon" />}
          </span>
          <span className="min-w-0">
            <span className="dropzone-title d-block">
              {uploading ? "Uploading" : draggingFiles ? "Release to upload" : "Drop files here"}
            </span>
            <span className="d-block text-body-secondary font-monospace small text-truncate" title={activePath}>
              {activePath || "Loading"}
            </span>
          </span>
        </span>
        <span className="dropzone-hint d-none d-sm-block">Choose files</span>
      </button>

      <Card className="overflow-hidden">
        <CardContent className="overflow-x-auto p-0">
          {error && (
            <div className="alert alert-danger rounded-0 border-0 border-bottom mb-0 py-2 px-3 small" role="alert">
              {error}
            </div>
          )}

          <div className="row g-0 px-3 py-2 border-bottom small text-body-secondary fw-semibold">
            <div className="col">Name</div>
            <div className="col-2">Size</div>
            <div className="col-3">Modified</div>
            <div className="col-2 text-end">Actions</div>
          </div>

          {listing?.parent && (
            <button
              type="button"
              onClick={() => setCurrentPath(listing.parent ?? undefined)}
              className="row g-0 w-100 text-start px-3 py-2 border-0 border-bottom bg-transparent hover:bg-body-tertiary"
            >
              <div className="col d-flex align-items-center gap-2 font-monospace text-body-secondary">
                <ArrowUp className="icon-sm flex-shrink-0" />
                ..
              </div>
              <div className="col-2" />
              <div className="col-3" />
              <div className="col-2" />
            </button>
          )}

          {loading && !listing ? (
            <div className="d-flex align-items-center justify-content-center gap-2 py-5 text-body-secondary">
              <Spinner />
              Loading files...
            </div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="py-5 text-center text-body-secondary">No files</div>
          ) : (
            listing?.entries.map((entry) => (
              <div
                key={entry.path}
                className="row g-0 px-3 py-2 border-bottom"
              >
                <div className="col">
                  <button
                    type="button"
                    onClick={() => (entry.is_directory ? openDirectory(entry) : void downloadFile(entry))}
                    className="d-flex align-items-center gap-2 border-0 bg-transparent p-0 text-start font-monospace text-body min-w-0"
                  >
                    {entry.is_directory ? (
                      <Folder className="icon-sm flex-shrink-0 text-warning" />
                    ) : (
                      <FileIcon className="icon-sm flex-shrink-0" />
                    )}
                    <span className="text-truncate">{entry.name}</span>
                  </button>
                </div>
                <div className="col-2 small text-body-secondary">{formatBytes(entry.size)}</div>
                <div className="col-3 small text-body-secondary text-truncate">
                  {Number.isFinite(entry.mtime) ? DATE_FORMAT.format(entry.mtime * 1000) : "-"}
                </div>
                <div className="col-2 d-flex justify-content-end gap-1">
                  {entry.is_directory ? (
                    <Button
                      ghost
                      size="icon"
                      type="button"
                      onClick={() => openDirectory(entry)}
                      aria-label={`Open ${entry.name}`}
                    >
                      <FolderOpen />
                    </Button>
                  ) : (
                    <Button
                      ghost
                      size="icon"
                      type="button"
                      onClick={() => void downloadFile(entry)}
                      aria-label={`Download ${entry.name}`}
                    >
                      <Download />
                    </Button>
                  )}
                  <Button
                    ghost
                    size="icon"
                    type="button"
                    onClick={() => setPendingDelete(entry)}
                    aria-label={`Delete ${entry.name}`}
                    className="text-danger"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <PluginSlot name="files:bottom" />

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          if (creating) return;
          setCreateDialogOpen(open);
          if (!open) setFolderName("");
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Target: {activePath || "Loading"}
            </DialogDescription>
          </DialogHeader>
          <div className="modal-body">
            <Input
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createDirectory();
              }}
              placeholder="Folder name"
              disabled={creating}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              outlined
              onClick={() => {
                setCreateDialogOpen(false);
                setFolderName("");
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void createDirectory()}
              disabled={creating}
              prefix={creating ? <Spinner /> : <FolderPlus />}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={Boolean(pendingDelete)}
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : "Delete item?"}
        description={
          pendingDelete?.is_directory
            ? "This removes the folder and everything inside it."
            : "This removes the file."
        }
      />
    </div>
  );
}