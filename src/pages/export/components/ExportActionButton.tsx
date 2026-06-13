import { Download } from 'lucide-react'
import { Button } from '@heroui/react'

interface ExportActionButtonProps {
  label: string
  isExporting: boolean
  disabled: boolean
  onClick: () => void
}

export default function ExportActionButton({ label, isExporting, disabled, onClick }: ExportActionButtonProps) {
  return (
    <Button
      variant="primary"
      fullWidth
      isPending={isExporting}
      isDisabled={disabled}
      onPress={onClick}
    >
      {!isExporting && <Download size={18} />}
      {isExporting ? '导出中...' : label}
    </Button>
  )
}
