import type { HttpBody, HttpBodyType, HttpFileRef, HttpMultipartPart } from '@atlas/contracts';
import { isSensitiveName } from '@atlas/contracts';
import { FileUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BODY_TYPE_LABELS, languageOf, prettyJson } from '../format';
import { KeyValueEditor } from './KeyValueEditor';
import { MonacoText } from './MonacoText';

const BODY_TYPES = Object.keys(BODY_TYPE_LABELS) as HttpBodyType[];

function emptyBody(type: HttpBodyType, previous: HttpBody): HttpBody {
  const text = 'text' in previous ? previous.text : '';
  switch (type) {
    case 'none':
      return { type };
    case 'json':
    case 'text':
    case 'xml':
      return { type, text };
    case 'form':
      return { type, fields: [] };
    case 'multipart':
      return { type, parts: [] };
    case 'binary':
      return { type, file: null, contentType: null };
  }
}

/** Chooses a file in the native picker; the Engine reads only picked files (R5). */
function useFilePicker() {
  const [error, setError] = useState<string | null>(null);
  const choose = async (): Promise<HttpFileRef | null> => {
    setError(null);
    try {
      return await unwrap(api().http.chooseFile());
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    }
  };
  return { choose, error };
}

function MultipartEditor({
  parts,
  onChange,
}: {
  parts: HttpMultipartPart[];
  onChange: (parts: HttpMultipartPart[]) => void;
}) {
  const picker = useFilePicker();
  const update = (index: number, part: HttpMultipartPart) =>
    onChange(parts.map((current, i) => (i === index ? part : current)));
  return (
    <div className="flex flex-col gap-1.5" data-testid="multipart-parts">
      {parts.length === 0 && <p className="text-muted-foreground text-sm">No parts yet.</p>}
      {parts.map((part, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1.4fr)_auto] items-center gap-1.5"
        >
          <Checkbox
            checked={part.enabled}
            onCheckedChange={(checked) => update(index, { ...part, enabled: checked === true })}
            aria-label="Send this part"
          />
          <Input
            value={part.name}
            onChange={(event) => update(index, { ...part, name: event.target.value })}
            placeholder="Name"
            aria-label="Part name"
            className="h-8 font-mono text-xs"
          />
          <Select
            value={part.kind}
            onValueChange={(kind) =>
              update(
                index,
                kind === 'file'
                  ? {
                      kind: 'file',
                      name: part.name,
                      file: null,
                      contentType: null,
                      enabled: part.enabled,
                    }
                  : {
                      kind: 'text',
                      name: part.name,
                      value: '',
                      enabled: part.enabled,
                      secret: false,
                    },
              )
            }
          >
            <SelectTrigger size="sm" className="w-20" aria-label="Part kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="file">File</SelectItem>
            </SelectContent>
          </Select>
          {part.kind === 'text' ? (
            <Input
              value={part.value}
              type={part.secret || isSensitiveName(part.name) ? 'password' : 'text'}
              autoComplete="off"
              onChange={(event) => update(index, { ...part, value: event.target.value })}
              placeholder="Value"
              aria-label="Part value"
              className="h-8 font-mono text-xs"
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="justify-start truncate"
              onClick={async () => {
                const file = await picker.choose();
                if (file) update(index, { ...part, file });
              }}
            >
              <FileUp /> {part.file?.name ?? 'Choose file…'}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove part ${part.name || index + 1}`}
            onClick={() => onChange(parts.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {picker.error && <p className="text-destructive text-xs">{picker.error}</p>}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...parts,
              { kind: 'text', name: '', value: '', enabled: true, secret: false },
            ])
          }
        >
          <Plus /> Add part
        </Button>
      </div>
    </div>
  );
}

/** Request body of every supported type (FR-1405); text bodies use Monaco. */
export function BodyEditor({
  body,
  onChange,
}: {
  body: HttpBody;
  onChange: (body: HttpBody) => void;
}) {
  const picker = useFilePicker();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="http-body-type" className="text-muted-foreground text-xs">
          Body
        </Label>
        <Select
          value={body.type}
          onValueChange={(type) => onChange(emptyBody(type as HttpBodyType, body))}
        >
          <SelectTrigger id="http-body-type" size="sm" className="w-44" aria-label="Body type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BODY_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {BODY_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {body.type === 'json' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...body, text: prettyJson(body.text) })}
          >
            Format JSON
          </Button>
        )}
      </div>
      {body.type === 'none' && (
        <p className="text-muted-foreground text-sm">This request sends no body.</p>
      )}
      {(body.type === 'json' || body.type === 'text' || body.type === 'xml') && (
        <MonacoText
          value={body.text}
          language={languageOf(body.type)}
          onChange={(text) => onChange({ ...body, text })}
          ariaLabel="Request body"
          className="min-h-40 flex-1"
          testId="request-body-editor"
        />
      )}
      {body.type === 'form' && (
        <KeyValueEditor
          rows={body.fields}
          onChange={(fields) => onChange({ ...body, fields })}
          noun="field"
          create={() => ({ name: '', value: '', enabled: true, secret: false })}
          testId="form-fields"
        />
      )}
      {body.type === 'multipart' && (
        <MultipartEditor parts={body.parts} onChange={(parts) => onChange({ ...body, parts })} />
      )}
      {body.type === 'binary' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const file = await picker.choose();
                if (file) onChange({ ...body, file });
              }}
            >
              <FileUp /> {body.file ? 'Choose another file…' : 'Choose file…'}
            </Button>
            <span className="text-muted-foreground truncate text-sm" data-testid="binary-file">
              {body.file?.name ?? 'No file chosen'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="http-binary-type" className="text-muted-foreground shrink-0 text-xs">
              Content type
            </Label>
            <Input
              id="http-binary-type"
              value={body.contentType ?? ''}
              onChange={(event) => onChange({ ...body, contentType: event.target.value || null })}
              placeholder="application/octet-stream"
              className="h-8 max-w-72 font-mono text-xs"
            />
          </div>
          {picker.error && <p className="text-destructive text-xs">{picker.error}</p>}
        </div>
      )}
    </div>
  );
}
