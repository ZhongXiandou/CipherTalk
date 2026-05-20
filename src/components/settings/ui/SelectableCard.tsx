import type { ChangeEventHandler, ReactNode } from 'react'
import { Check } from 'lucide-react'
import './SelectableCard.scss'

interface SelectableCardProps {
  type: 'radio' | 'checkbox'
  checked: boolean
  children: ReactNode
  className?: string
  checkClassName?: string
  disabled?: boolean
  name?: string
  value?: string | number
  onChange?: ChangeEventHandler<HTMLInputElement>
}

function SelectableCard({
  type,
  checked,
  children,
  className = '',
  checkClassName = '',
  disabled = false,
  name,
  value,
  onChange
}: SelectableCardProps) {
  const classes = [className, checked ? 'active' : '', disabled ? 'disabled' : ''].filter(Boolean).join(' ')

  return (
    <label className={classes}>
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {children}
      {checked && (
        <div className={checkClassName}>
          <Check size={14} />
        </div>
      )}
    </label>
  )
}

export default SelectableCard
