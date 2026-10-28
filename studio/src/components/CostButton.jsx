// 开源版没有积分/计费：费用按钮退化为普通按钮，保留原有调用点。
import { Button } from './ui.jsx';

export default function CostButton({ cost: _cost, children, className = '', title, variant = 'secondary', ...rest }) {
  return (
    <Button variant={variant} className={className} title={title} {...rest}>
      {children}
    </Button>
  );
}
