import './Loader.css';

export default function Loader({ size = 40 }) {
  return (
    <div className="loader-container">
      <div className="loader" style={{ width: size, height: size }} />
    </div>
  );
}
