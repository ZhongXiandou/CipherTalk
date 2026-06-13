import { FolderOpen } from 'lucide-react'
import { TextField, Input, Button } from '@heroui/react'

interface ExportPathSelectProps {
  exportFolder: string
  onSelect: () => void
}

export default function ExportPathSelect({ exportFolder, onSelect }: ExportPathSelectProps) {
  return (
    <div className="flex items-center gap-2">
      <TextField aria-label="导出位置" value={exportFolder} isReadOnly className="min-w-0 flex-1">
        <Input placeholder="点击选择导出位置" />
      </TextField>
      <Button variant="secondary" onPress={onSelect}>
        <FolderOpen size={16} />
        浏览
      </Button>
    </div>
  )
}
