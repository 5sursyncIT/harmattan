import { useState } from 'react';
import { FiChevronDown, FiChevronUp } from 'react-icons/fi';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import './FAQPage.css';

function FAQItem({ question, answer }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`faq-item ${open ? 'open' : ''}`}>
      <button className="faq-question" onClick={() => setOpen(!open)}>
        <span>{question}</span>
        {open ? <FiChevronUp /> : <FiChevronDown />}
      </button>
      {open && <div className="faq-answer"><p>{answer}</p></div>}
    </div>
  );
}

export default function FAQPage() {
  const config = useSiteConfig();
  const faqData = config?.faq || [];

  return (
    <div className="faq-page">
      <div className="container">
        <h1>Questions fréquentes</h1>
        <p className="faq-intro">
          Retrouvez les réponses aux questions les plus fréquentes. Si vous ne trouvez pas
          la réponse à votre question, n'hésitez pas à nous contacter.
        </p>

        {faqData.map((section) => (
          <div key={section.category} className="faq-section">
            <h2>{section.category}</h2>
            <div className="faq-list">
              {section.questions.map((item, idx) => (
                <FAQItem key={idx} question={item.q} answer={item.a} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
