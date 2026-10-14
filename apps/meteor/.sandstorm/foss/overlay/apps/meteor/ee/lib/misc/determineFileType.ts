// SANDSTORM-FOSS-STUB (MIT). Used by the Apps-Engine upload bridge, which a Community build never starts.
import { getMimeTypeFromFileName } from '../../../app/utils/lib/mimeTypes';

export function determineFileType(_buffer: Buffer, name: string): string {
	return getMimeTypeFromFileName(name);
}
