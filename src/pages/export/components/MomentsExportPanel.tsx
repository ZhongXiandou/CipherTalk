import { RefreshCw } from 'lucide-react'
import { ScrollShadow, Button, Typography } from '@heroui/react'
import DateRangePicker from '../../../components/DateRangePicker'
import type { MomentsExportOptions } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useMomentsExport } from '../hooks/useMomentsExport'
import { momentsFormatOptions } from '../constants'
import MomentsList from './MomentsList'
import FormatPicker from './FormatPicker'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface MomentsExportPanelProps {
  moments: ReturnType<typeof useMomentsExport>
  shared: ExportShared
}

export default function MomentsExportPanel({ moments: momentsHook, shared }: MomentsExportPanelProps) {
  const {
    moments,
    isLoadingMoments,
    momentsOptions,
    setMomentsOptions,
    loadMoments,
    startMomentsExport
  } = momentsHook

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
      {/* 左侧：朋友圈预览 */}
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden lg:border-r lg:border-default lg:pr-3">
        <div className="flex items-center justify-between">
          <Typography type="h6">朋友圈预览</Typography>
          <Button isIconOnly variant="tertiary" size="sm" isDisabled={isLoadingMoments} onPress={loadMoments}>
            <RefreshCw size={16} className={isLoadingMoments ? 'animate-spin' : ''} />
          </Button>
        </div>

        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <MomentsList isLoading={isLoadingMoments} moments={moments} />
        </ScrollShadow>
      </div>

      {/* 右侧：导出设置 */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <div className="flex flex-col gap-5 px-1 py-1">
            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出格式</Typography>
              <FormatPicker
                aria-label="导出格式"
                options={momentsFormatOptions}
                value={momentsOptions.format}
                onChange={(value) => setMomentsOptions(prev => ({ ...prev, format: value as MomentsExportOptions['format'] }))}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">时间范围</Typography>
              <div className="max-w-xs">
                <DateRangePicker
                  startDate={momentsOptions.startDate}
                  endDate={momentsOptions.endDate}
                  onStartDateChange={(date) => setMomentsOptions(prev => ({ ...prev, startDate: date }))}
                  onEndDateChange={(date) => setMomentsOptions(prev => ({ ...prev, endDate: date }))}
                />
              </div>
              <Typography type="body-xs" className="text-muted">不选择时间范围则导出全部朋友圈</Typography>
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出位置</Typography>
              <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
            </section>
          </div>
        </ScrollShadow>

        <div className="border-t border-default pt-3">
          <ExportActionButton
            label="导出朋友圈"
            isExporting={shared.isExporting}
            disabled={!shared.exportFolder || shared.isExporting || moments.length === 0}
            onClick={startMomentsExport}
          />
        </div>
      </div>
    </div>
  )
}
