import { RefreshCw, User, Users, MessageSquare, CircleUserRound } from 'lucide-react'
import { ScrollShadow, Button, Typography } from '@heroui/react'
import type { ContactExportOptions } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useContactExport } from '../hooks/useContactExport'
import { contactFormatOptions } from '../constants'
import ExportSearchBar from './ExportSearchBar'
import ContactList from './ContactList'
import FormatPicker from './FormatPicker'
import OptionCardGroup from './OptionCardGroup'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface ContactsExportPanelProps {
  contact: ReturnType<typeof useContactExport>
  shared: ExportShared
}

const contactTypeToggles: { key: keyof ContactExportOptions['contactTypes']; label: string; icon: typeof User }[] = [
  { key: 'friends', label: '好友', icon: User },
  { key: 'groups', label: '群聊', icon: Users },
  { key: 'officials', label: '公众号', icon: MessageSquare }
]

export default function ContactsExportPanel({ contact, shared }: ContactsExportPanelProps) {
  const {
    filteredContacts,
    selectedContacts,
    setSelectedContacts,
    contactSearchKeyword,
    setContactSearchKeyword,
    isLoadingContacts,
    contactOptions,
    setContactOptions,
    loadContacts,
    toggleSelectAllContacts,
    startContactExport
  } = contact

  const allSelected = selectedContacts.size === filteredContacts.length && filteredContacts.length > 0

  const setContactType = (key: keyof ContactExportOptions['contactTypes'], value: boolean) =>
    setContactOptions(prev => ({ ...prev, contactTypes: { ...prev.contactTypes, [key]: value } }))

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
      {/* 左侧：通讯录预览 */}
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden lg:border-r lg:border-default lg:pr-3">
        <div className="flex items-center justify-between">
          <Typography type="h6">通讯录预览</Typography>
          <Button isIconOnly variant="tertiary" size="sm" isDisabled={isLoadingContacts} onPress={loadContacts}>
            <RefreshCw size={16} className={isLoadingContacts ? 'animate-spin' : ''} />
          </Button>
        </div>

        <ExportSearchBar
          aria-label="搜索联系人"
          value={contactSearchKeyword}
          onChange={setContactSearchKeyword}
          placeholder="搜索联系人..."
        />

        <div className="flex items-center justify-between gap-2">
          <Button variant="tertiary" size="sm" onPress={toggleSelectAllContacts}>{allSelected ? '取消全选' : '全选'}</Button>
          <Typography type="body-xs" className="shrink-0 text-muted">
            {selectedContacts.size > 0 ? `已选 ${selectedContacts.size} 个` : `共 ${filteredContacts.length} 个联系人`}
          </Typography>
        </div>

        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <ContactList
            isLoading={isLoadingContacts}
            contacts={filteredContacts}
            selectedContacts={selectedContacts}
            onSelectionChange={setSelectedContacts}
          />
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
                options={contactFormatOptions}
                value={contactOptions.format}
                onChange={(value) => setContactOptions(prev => ({ ...prev, format: value as ContactExportOptions['format'] }))}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">联系人类型</Typography>
              <OptionCardGroup
                aria-label="联系人类型"
                items={contactTypeToggles}
                isSelected={(key) => contactOptions.contactTypes[key as keyof ContactExportOptions['contactTypes']]}
                onToggle={(key, checked) => setContactType(key as keyof ContactExportOptions['contactTypes'], checked)}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出选项</Typography>
              <OptionCardGroup
                aria-label="导出选项"
                items={[{ key: 'exportAvatars', label: '导出头像', icon: CircleUserRound }]}
                isSelected={() => contactOptions.exportAvatars}
                onToggle={(_key, checked) => setContactOptions(prev => ({ ...prev, exportAvatars: checked }))}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出位置</Typography>
              <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
            </section>
          </div>
        </ScrollShadow>

        <div className="border-t border-default pt-3">
          <ExportActionButton
            label="导出通讯录"
            isExporting={shared.isExporting}
            disabled={!shared.exportFolder || shared.isExporting}
            onClick={startContactExport}
          />
        </div>
      </div>
    </div>
  )
}
