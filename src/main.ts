import './styles/tokens.css';
import './styles/base.css';
import './styles/login.css';
import './styles/viewer.css';
import { initLogin } from './ui/login';
import { initViewer } from './ui/viewer';
import { initCapture } from './ui/capture';
import { initPwa } from './ui/pwa';

initLogin();
initCapture(initViewer());
initPwa();
